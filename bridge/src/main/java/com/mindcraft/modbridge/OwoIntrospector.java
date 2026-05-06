package com.mindcraft.modbridge;

import org.objectweb.asm.ClassReader;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;
import org.objectweb.asm.tree.*;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.*;
import java.util.*;
import java.util.jar.*;
import java.util.stream.Stream;

/**
 * ASM bytecode scan for owo-lib channel registrations across an entire modpack.
 *
 *  • Recurses into nested jars (Fabric jar-in-jar) so bundled mods get scanned.
 *  • Resolves channel Identifier from three patterns:
 *      A. NEW Identifier; LDC ns; LDC path; INVOKESPECIAL <init>(String,String)
 *      B. LDC ns; LDC path; INVOKESTATIC Identifier.of(String,String)
 *      C. LDC path; INVOKESTATIC <Mod>.id(String)Identifier
 *           (one-arg factory; resolved by reading the factory's bytecode for its
 *            constant namespace string)
 *      D. fallback: use the fabric.mod.json mod id as namespace.
 *  • Tracks PUTSTATIC field so registrations across separate methods/classes
 *    bind to the right channel via GETSTATIC walk-back.
 *
 * Hash:
 *     identifierHash = 31 * namespace.hashCode() + path.hashCode()
 *     channelHash    = 31 * identifierHash + sum over packets of (idx*31 + className.hashCode())
 */
public final class OwoIntrospector {

    public static final class Result {
        public final Map<String, Integer> requiredChannels    = new TreeMap<>();
        public final Map<String, Integer> requiredControllers = new TreeMap<>();
        public final Map<String, Integer> optionalChannels    = new TreeMap<>();
        public final List<String> scanLog = new ArrayList<>();
        public int modJarCount = 0;
    }

    private static final class Channel {
        final String fieldKey;       // "owner.fieldName" (PUTSTATIC target) or synthetic
        final String channelId;      // "ns:path"
        final boolean optional;
        // Source-order list of registrations; each entry is (kind, packetClassName).
        // Kind 0=registerServerbound, 1=registerClientboundDeferred, 2=registerClientbound.
        // We simulate owo's serializersByIndex map at hash time to handle the
        // server/client index sign collision (Java -0 == 0).
        final List<int[]> regKind = new ArrayList<>();
        final List<String> regClass = new ArrayList<>();
        Channel(String fieldKey, String channelId, boolean optional) {
            this.fieldKey = fieldKey; this.channelId = channelId; this.optional = optional;
        }
    }

    /** ParticleSystemController: hash uses sum of system indices, not class names. */
    private static final class Controller {
        final String fieldKey;
        final String channelId;
        int systemCount = 0;
        Controller(String fieldKey, String channelId) {
            this.fieldKey = fieldKey; this.channelId = channelId;
        }
    }

    /** Per-class metadata: which mod jar it came from (for fallback namespace inference). */
    private static final class ClassEntry {
        final ClassNode cn;
        final String modId; // may be empty if no fabric.mod.json or unparseable
        ClassEntry(ClassNode cn, String modId) { this.cn = cn; this.modId = modId; }
    }

    /**
     * Heuristic: dedicated-server doesn't load Fabric `entrypoints.client` classes
     * (or classes those entrypoints transitively call). Mineflayer talks to the
     * dedicated server, so we must ignore client-only registrations when computing
     * hashes — otherwise our serializersByIndex picture diverges from the server's.
     *
     * Heuristic markers (cheap, false-positive risk acceptable):
     *  • Class implements net/fabricmc/api/ClientModInitializer.
     *  • Class path contains a "/client/" segment.
     *  • Class implements client-environment Fabric API interfaces (e.g. ClientPlayConnectionEvents).
     */
    private static boolean isClientOnly(ClassNode cn) {
        if (cn == null) return false;
        if (cn.name.contains("/client/") || cn.name.endsWith("/Client")) return true;
        if (cn.interfaces != null) {
            for (String iface : cn.interfaces) {
                if (iface.equals("net/fabricmc/api/ClientModInitializer")) return true;
            }
        }
        return false;
    }

    public static Result scan(Path modsDir) throws IOException {
        Result r = new Result();
        if (!Files.isDirectory(modsDir)) {
            r.scanLog.add("mods dir missing: " + modsDir);
            return r;
        }

        // Pass 0: load all classes (including nested-jar classes), tag with mod id.
        Map<String, ClassEntry> classes = new LinkedHashMap<>();
        try (Stream<Path> files = Files.list(modsDir)) {
            for (Path jar : (Iterable<Path>) files.filter(p -> p.toString().endsWith(".jar"))::iterator) {
                r.modJarCount++;
                try {
                    loadJar(Files.readAllBytes(jar), jar.getFileName().toString(), classes, r);
                } catch (Throwable t) {
                    r.scanLog.add("jar-fail " + jar.getFileName() + ": " + t.getClass().getSimpleName() + " " + t.getMessage());
                }
            }
        }

        // Pass 1: discover channels + controllers.
        Map<String, Channel> channelByField = new LinkedHashMap<>();
        Map<String, Controller> controllerByField = new LinkedHashMap<>();
        for (ClassEntry ce : classes.values()) {
            if (ce.cn.methods == null) continue;
            for (MethodNode m : ce.cn.methods) {
                if (m.instructions == null) continue;
                AbstractInsnNode[] arr = m.instructions.toArray();
                for (int i = 0; i < arr.length; i++) {
                    if (!(arr[i] instanceof MethodInsnNode mi)) continue;

                    if ("io/wispforest/owo/network/OwoNetChannel".equals(mi.owner)
                            && (mi.name.equals("create") || mi.name.equals("createOptional"))) {
                        String channelId = resolveChannelId(arr, i, classes, ce.modId);
                        if (channelId == null) {
                            r.scanLog.add("create-no-id " + ce.cn.name + "#" + m.name + " (modId=" + ce.modId + ")");
                            continue;
                        }
                        String fieldKey = walkForwardForPutstatic(arr, i);
                        if (fieldKey == null) fieldKey = ce.cn.name + ".#anon@" + i + "@" + m.name;
                        boolean optional = mi.name.equals("createOptional");
                        channelByField.put(fieldKey, new Channel(fieldKey, channelId, optional));
                        r.scanLog.add("create " + channelId + " -> " + fieldKey + (optional ? " (optional)" : ""));
                        continue;
                    }
                    // Controllers: NEW ParticleSystemController; DUP; <Identifier>; INVOKESPECIAL <init>(Identifier)V; PUTSTATIC.
                    if ("io/wispforest/owo/particles/systems/ParticleSystemController".equals(mi.owner)
                            && mi.name.equals("<init>") && mi.desc != null
                            && mi.desc.startsWith("(Lnet/minecraft/")) {
                        String ctrlId = resolveChannelId(arr, i, classes, ce.modId);
                        if (ctrlId == null) {
                            r.scanLog.add("ctrl-no-id " + ce.cn.name + "#" + m.name);
                            continue;
                        }
                        String fieldKey = walkForwardForPutstatic(arr, i);
                        if (fieldKey == null) fieldKey = ce.cn.name + ".#ctrl@" + i + "@" + m.name;
                        controllerByField.put(fieldKey, new Controller(fieldKey, ctrlId));
                        r.scanLog.add("controller " + ctrlId + " -> " + fieldKey);
                    }
                }
            }
        }

        // Pass 2: collect packet registrations on channels + system registrations on controllers.
        // Skip client-only classes — dedicated server never loads them, so their
        // register* calls don't appear in the server's serializersByIndex map and
        // including them would break hash parity.
        for (ClassEntry ce : classes.values()) {
            if (ce.cn.methods == null) continue;
            if (isClientOnly(ce.cn)) {
                r.scanLog.add("skip-client-only " + ce.cn.name);
                continue;
            }
            for (MethodNode m : ce.cn.methods) {
                if (m.instructions == null) continue;
                AbstractInsnNode[] arr = m.instructions.toArray();
                for (int i = 0; i < arr.length; i++) {
                    if (!(arr[i] instanceof MethodInsnNode mi)) continue;

                    // Channel packet registrations.
                    if ("io/wispforest/owo/network/OwoNetChannel".equals(mi.owner)
                            && mi.name.startsWith("register")) {
                        String fieldKey = walkBackForGetstatic(arr, i, "Lio/wispforest/owo/network/OwoNetChannel;");
                        Channel ch = fieldKey == null ? null : channelByField.get(fieldKey);
                        if (ch == null) continue;
                        String packet = walkBackForClassLdc(arr, i);
                        if (packet == null) continue;
                        int kind;
                        switch (mi.name) {
                            case "registerServerbound":          kind = 0; break;
                            case "registerClientboundDeferred":  kind = 1; break;
                            case "registerClientbound":          kind = 2; break;
                            default: continue;
                        }
                        ch.regKind.add(new int[]{kind});
                        ch.regClass.add(packet);
                        continue;
                    }

                    // Controller system registrations: ParticleSystemController.register(Class, executor)
                    if ("io/wispforest/owo/particles/systems/ParticleSystemController".equals(mi.owner)
                            && mi.name.equals("register")) {
                        String fieldKey = walkBackForGetstatic(arr, i,
                                "Lio/wispforest/owo/particles/systems/ParticleSystemController;");
                        Controller c = fieldKey == null ? null : controllerByField.get(fieldKey);
                        if (c == null) continue;
                        c.systemCount++;
                    }
                }
            }
        }

        // Hash + bucket.
        for (Channel ch : channelByField.values()) {
            int hash = computeChannelHash(ch, r);
            (ch.optional ? r.optionalChannels : r.requiredChannels).put(ch.channelId, hash);
        }
        for (Controller c : controllerByField.values()) {
            int hash = computeControllerHash(c);
            r.requiredControllers.put(c.channelId, hash);
            r.scanLog.add("ctrl-hash " + c.channelId + " = " + hash + " (" + c.systemCount + " systems)");
        }
        return r;
    }

    // ------------------------------------------------------------------ I/O

    private static void loadJar(byte[] jarBytes, String label, Map<String, ClassEntry> classes, Result r) throws IOException {
        String modId = "";
        // First read fabric.mod.json for mod id (best-effort, primitive parser).
        try (JarInputStream pre = new JarInputStream(new ByteArrayInputStream(jarBytes))) {
            JarEntry e;
            while ((e = pre.getNextJarEntry()) != null) {
                if (!"fabric.mod.json".equals(e.getName())) continue;
                byte[] buf = pre.readAllBytes();
                modId = extractModId(new String(buf));
                break;
            }
        }
        // Then walk all entries, extracting classes + recursing into nested jars.
        try (JarInputStream js = new JarInputStream(new ByteArrayInputStream(jarBytes))) {
            JarEntry e;
            while ((e = js.getNextJarEntry()) != null) {
                String n = e.getName();
                if (n.startsWith("META-INF/jars/") && n.endsWith(".jar")) {
                    byte[] nested = js.readAllBytes();
                    try {
                        loadJar(nested, label + "!/" + n, classes, r);
                    } catch (Throwable t) {
                        r.scanLog.add("nested-fail " + label + "!/" + n + ": " + t.getMessage());
                    }
                } else if (n.endsWith(".class") && !n.startsWith("META-INF/")) {
                    try {
                        ClassNode cn = new ClassNode();
                        new ClassReader(js.readAllBytes()).accept(cn, ClassReader.SKIP_FRAMES | ClassReader.SKIP_DEBUG);
                        classes.putIfAbsent(cn.name, new ClassEntry(cn, modId));
                    } catch (Throwable t) {
                        r.scanLog.add("class-fail " + label + "!" + n + ": " + t.getClass().getSimpleName());
                    }
                }
            }
        }
    }

    /** Crude JSON peek for "id":"foo" without pulling in a JSON library. */
    private static String extractModId(String fabricModJson) {
        // Find the *top-level* "id":"…" — be lax; first occurrence outside of "depends" etc. is good enough.
        int idx = fabricModJson.indexOf("\"id\"");
        if (idx < 0) return "";
        int colon = fabricModJson.indexOf(':', idx);
        int q1 = fabricModJson.indexOf('"', colon + 1);
        int q2 = fabricModJson.indexOf('"', q1 + 1);
        if (q1 < 0 || q2 < 0) return "";
        return fabricModJson.substring(q1 + 1, q2);
    }

    // ------------------------------------------------------------------ Channel ID resolution

    private static String resolveChannelId(AbstractInsnNode[] arr, int createIdx,
                                           Map<String, ClassEntry> classes, String fallbackModId) {
        // Pattern A/B: <init>(String,String) or .of(String,String).
        String fromTwoArg = walkBackForTwoStringIdentifier(arr, createIdx);
        if (fromTwoArg != null) return fromTwoArg;

        // Pattern C: 1-arg factory.
        String fromOneArgFactory = walkBackForOneArgFactory(arr, createIdx, classes);
        if (fromOneArgFactory != null) return fromOneArgFactory;

        // Pattern D: fallback to mod id + the LDC string immediately preceding create.
        String pathOnly = walkBackForSingleStringLdc(arr, createIdx);
        if (pathOnly != null && !fallbackModId.isEmpty()) {
            return fallbackModId + ":" + pathOnly;
        }
        return null;
    }

    /** NEW Identifier; LDC ns; LDC path; INVOKESPECIAL <init>(String,String)  OR  Identifier.of(String,String) */
    private static String walkBackForTwoStringIdentifier(AbstractInsnNode[] arr, int from) {
        for (int j = from - 1; j >= 0 && j >= from - 50; j--) {
            if (!(arr[j] instanceof MethodInsnNode mi)) continue;
            boolean isCtor = mi.name.equals("<init>") && mi.desc != null
                    && mi.desc.equals("(Ljava/lang/String;Ljava/lang/String;)V");
            boolean isOf = mi.name.equals("of") && mi.desc != null
                    && mi.desc.startsWith("(Ljava/lang/String;Ljava/lang/String;)L");
            if (!isCtor && !isOf) continue;
            String[] strings = collectPrecedingStringLdcs(arr, j, 2);
            if (strings.length == 2) return strings[1] + ":" + strings[0]; // ns then path on stack: ns is deeper
        }
        return null;
    }

    /**
     * INVOKESTATIC <X>.<m>(Ljava/lang/String;)L<resultType>; preceded by LDC path.
     * Resolves the factory by inspecting its bytecode: looks for an Identifier
     * construction with one constant LDC + the parameter (aload 0).
     */
    private static String walkBackForOneArgFactory(AbstractInsnNode[] arr, int from,
                                                    Map<String, ClassEntry> classes) {
        for (int j = from - 1; j >= 0 && j >= from - 30; j--) {
            if (!(arr[j] instanceof MethodInsnNode mi)) continue;
            if (mi.getOpcode() != Opcodes.INVOKESTATIC) continue;
            if (mi.desc == null) continue;
            // arg list: single String, returning a reference type
            if (!mi.desc.startsWith("(Ljava/lang/String;)L")) continue;

            String pathArg = collectPrecedingStringLdcs(arr, j, 1).length == 1
                    ? collectPrecedingStringLdcs(arr, j, 1)[0] : null;
            if (pathArg == null) continue;

            String ns = resolveOneArgFactoryNamespace(mi.owner, mi.name, mi.desc, classes);
            if (ns != null) return ns + ":" + pathArg;
        }
        return null;
    }

    /** Looks back for a single LDC string (used as fallback path arg). */
    private static String walkBackForSingleStringLdc(AbstractInsnNode[] arr, int from) {
        String[] s = collectPrecedingStringLdcs(arr, from, 1);
        return s.length == 1 ? s[0] : null;
    }

    /** Collects up to N preceding LDC string constants in stack order (top-of-stack first). */
    private static String[] collectPrecedingStringLdcs(AbstractInsnNode[] arr, int from, int n) {
        List<String> out = new ArrayList<>();
        for (int k = from - 1; k >= 0 && k >= from - 30 && out.size() < n; k--) {
            if (arr[k] instanceof LdcInsnNode l && l.cst instanceof String s) out.add(s);
        }
        return out.toArray(new String[0]);
    }

    /** Inspects the body of a 1-arg static factory to find its namespace constant. */
    private static String resolveOneArgFactoryNamespace(String owner, String name, String desc,
                                                         Map<String, ClassEntry> classes) {
        ClassEntry ce = classes.get(owner);
        if (ce == null || ce.cn.methods == null) return null;
        MethodNode target = null;
        for (MethodNode m : ce.cn.methods) {
            if (m.name.equals(name) && m.desc.equals(desc)) { target = m; break; }
        }
        if (target == null || target.instructions == null) return null;

        // Look for: LDC ns; <something>; INVOKESPECIAL Identifier.<init>(String,String)V
        // OR:       LDC ns; INVOKESTATIC Identifier.of(String,String)
        AbstractInsnNode[] arr = target.instructions.toArray();
        for (int i = 0; i < arr.length; i++) {
            if (!(arr[i] instanceof MethodInsnNode mi)) continue;
            boolean ctor = mi.name.equals("<init>") && mi.desc != null
                    && mi.desc.equals("(Ljava/lang/String;Ljava/lang/String;)V");
            boolean of = mi.name.equals("of") && mi.desc != null
                    && mi.desc.startsWith("(Ljava/lang/String;Ljava/lang/String;)L");
            if (!ctor && !of) continue;
            // The factory likely is `new Identifier(<constant>, parameter)`. The constant LDC
            // appears before any aload 0. Find the LDC.
            for (int k = i - 1; k >= 0 && k >= i - 10; k--) {
                if (arr[k] instanceof LdcInsnNode l && l.cst instanceof String s) return s;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ Misc walk helpers

    private static String walkForwardForPutstatic(AbstractInsnNode[] arr, int from) {
        for (int j = from + 1; j < arr.length && j <= from + 10; j++) {
            if (arr[j] instanceof FieldInsnNode fi && fi.getOpcode() == Opcodes.PUTSTATIC) {
                return fi.owner + "." + fi.name;
            }
        }
        return null;
    }

    private static String walkBackForGetstatic(AbstractInsnNode[] arr, int from, String desc) {
        for (int j = from - 1; j >= 0 && j >= from - 30; j--) {
            if (arr[j] instanceof FieldInsnNode fi && fi.getOpcode() == Opcodes.GETSTATIC
                    && desc.equals(fi.desc)) {
                return fi.owner + "." + fi.name;
            }
        }
        return null;
    }

    private static String walkBackForClassLdc(AbstractInsnNode[] arr, int from) {
        for (int j = from - 1; j >= 0 && j >= from - 30; j--) {
            if (arr[j] instanceof LdcInsnNode l && l.cst instanceof Type t && t.getSort() == Type.OBJECT) {
                return t.getClassName();
            }
        }
        return null;
    }

    /**
     * Replays the registration sequence to reconstruct owo's serializersByIndex map.
     *
     * Critical: OwoNetChannel's constructor pre-populates BOTH `clientHandlers`
     * and `serverHandlers` with a single null sentinel. So the first registerServerbound
     * sees `serverHandlers.size() == 1` and assigns idx=1 (not 0). Same for client.
     * Net effect: indices run 1..N for serverbound (positive keys) and -1..-N for
     * clientbound (negative keys) — no 0/-0 collision.
     *
     * Hash = 31 * Identifier.hashCode() + Σ (key*31 + className.hashCode()).
     */
    private static int computeChannelHash(Channel ch, Result r) {
        Map<Integer, String> serializersByIndex = new LinkedHashMap<>();
        Map<String, Integer> deferredClient = new LinkedHashMap<>();
        // Pre-populated with sentinel → first real index is 1, not 0.
        int serverIdx = 1;
        int clientIdx = 1;

        for (int n = 0; n < ch.regKind.size(); n++) {
            int kind = ch.regKind.get(n)[0];
            String pkt = ch.regClass.get(n);
            if (kind == 0) {                                     // registerServerbound
                serializersByIndex.put(serverIdx, pkt);
                serverIdx++;
            } else if (kind == 1) {                              // registerClientboundDeferred
                serializersByIndex.put(-clientIdx, pkt);         // Java: -0 == 0
                deferredClient.put(pkt, clientIdx);
                clientIdx++;
            } else {                                             // registerClientbound
                if (deferredClient.containsKey(pkt)) {
                    // Handler attached to existing deferred index — no change to serializersByIndex.
                    deferredClient.remove(pkt);
                } else {
                    serializersByIndex.put(-clientIdx, pkt);
                    clientIdx++;
                }
            }
        }

        int idHash = identifierHash(ch.channelId);
        int serializersHash = 0;
        for (Map.Entry<Integer, String> e : serializersByIndex.entrySet()) {
            serializersHash += e.getKey() * 31 + e.getValue().hashCode();
        }
        int hash = 31 * idHash + serializersHash;
        r.scanLog.add("hash " + ch.channelId + " = " + hash + " ("
                + ch.regClass.size() + " regs, " + serializersByIndex.size() + " entries)");
        for (Map.Entry<Integer, String> e : serializersByIndex.entrySet()) {
            r.scanLog.add("  [" + e.getKey() + "] " + e.getValue());
        }
        return hash;
    }

    /** Controller hash: 31 * Identifier.hashCode() + sum of system indices (0..systemCount-1). */
    private static int computeControllerHash(Controller c) {
        int idHash = identifierHash(c.channelId);
        int sum = 0;
        for (int i = 0; i < c.systemCount; i++) sum += i;
        return 31 * idHash + sum;
    }

    private static int identifierHash(String channelId) {
        int colon = channelId.indexOf(':');
        String ns = colon >= 0 ? channelId.substring(0, colon) : "minecraft";
        String path = colon >= 0 ? channelId.substring(colon + 1) : channelId;
        return 31 * ns.hashCode() + path.hashCode();
    }
}
