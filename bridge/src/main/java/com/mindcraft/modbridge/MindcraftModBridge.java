package com.mindcraft.modbridge;

import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

/**
 * mindcraft-modbridge: persistent local daemon. Loads modpack jars,
 * exposes their network protocol metadata over HTTP for the JS bot to query.
 *
 * Phase 1 surface:
 *   GET /health        -> daemon status + mod count
 *   GET /owo/hashes    -> 3-map JSON for owo:handshake response
 *
 * Run: ./build.sh && ./run.sh [modsDir] [port]
 */
public final class MindcraftModBridge {

    static final AtomicReference<OwoIntrospector.Result> OWO = new AtomicReference<>();
    static volatile int MOD_COUNT = 0;
    static volatile String MODS_DIR = "";

    // Cache for the registry-dump JSON keyed by file mtime so we re-read only when
    // the dumper rewrites it on a server restart, not on every HTTP request.
    private static volatile long REGISTRY_CACHE_MTIME = -1;
    private static volatile String REGISTRY_CACHE_TEXT = null;

    public static void main(String[] args) throws Exception {
        String modsDir = args.length > 0 ? args[0]
                : System.getProperty("user.home") + "/Library/Application Support/ModrinthApp/profiles/Homestead/mods";
        int port = args.length > 1 ? Integer.parseInt(args[1]) : 7474;

        MODS_DIR = modsDir;
        System.out.println("[bridge] mods dir: " + modsDir);
        System.out.println("[bridge] port    : " + port);

        // Scan + introspect synchronously at startup so /owo/hashes is ready immediately.
        try {
            long t0 = System.currentTimeMillis();
            OwoIntrospector.Result r = OwoIntrospector.scan(Path.of(modsDir));
            OWO.set(r);
            MOD_COUNT = r.modJarCount;
            System.out.printf("[bridge] introspection ok: %d mods, %d required, %d controllers, %d optional, %d ms%n",
                    r.modJarCount, r.requiredChannels.size(), r.requiredControllers.size(),
                    r.optionalChannels.size(), System.currentTimeMillis() - t0);
        } catch (Throwable t) {
            System.err.println("[bridge] introspection FAILED: " + t);
            t.printStackTrace();
            // Continue anyway so /health can report the failure.
        }

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.createContext("/health", MindcraftModBridge::handleHealth);
        server.createContext("/owo/hashes", MindcraftModBridge::handleOwoHashes);
        server.createContext("/owo/debug", MindcraftModBridge::handleOwoDebug);
        server.createContext("/registry/blocks", ex -> handleRegistry(ex, "blocks"));
        server.createContext("/registry/items",  ex -> handleRegistry(ex, "items"));
        server.setExecutor(null);
        server.start();
        System.out.println("[bridge] Bridge listening on :" + port);
    }

    private static void handleRegistry(HttpExchange ex, String key) throws IOException {
        Path file = registryPath();
        if (!Files.isRegularFile(file)) {
            respond(ex, 503, "{\"error\":\"registry dump not found\",\"path\":\"" + jsonEscape(file.toString()) + "\"}");
            return;
        }
        String all = readRegistryCached(file);
        String marker = "\"" + key + "\":";
        int start = all.indexOf(marker);
        if (start < 0) {
            respond(ex, 404, "{\"error\":\"key not in dump\",\"key\":\"" + key + "\"}");
            return;
        }
        // Brace-balance scan to find the matching `}`. Acceptable here because
        // RegistryDumper's output is a flat 2-level object — keys are ASCII-safe
        // ids and values are simple strings; no nested braces inside values.
        int objStart = all.indexOf('{', start);
        int depth = 0, objEnd = -1;
        for (int i = objStart; i < all.length(); i++) {
            char c = all.charAt(i);
            if (c == '{') depth++;
            else if (c == '}' && --depth == 0) { objEnd = i + 1; break; }
        }
        if (objEnd < 0) {
            respond(ex, 500, "{\"error\":\"malformed registry dump\"}");
            return;
        }
        respond(ex, 200, all.substring(objStart, objEnd));
    }

    private static String readRegistryCached(Path file) throws IOException {
        long mtime = Files.getLastModifiedTime(file).toMillis();
        if (REGISTRY_CACHE_TEXT != null && REGISTRY_CACHE_MTIME == mtime) {
            return REGISTRY_CACHE_TEXT;
        }
        String text = Files.readString(file, StandardCharsets.UTF_8);
        REGISTRY_CACHE_TEXT = text;
        REGISTRY_CACHE_MTIME = mtime;
        return text;
    }

    private static Path registryPath() {
        String env = System.getenv("CHDUMP_REGISTRY_PATH");
        if (env != null && !env.isEmpty()) return Path.of(env);
        return Path.of(System.getProperty("java.io.tmpdir"), "mindcraft-modcompat-registry.json");
    }

    private static void handleHealth(HttpExchange ex) throws IOException {
        OwoIntrospector.Result r = OWO.get();
        StringBuilder b = new StringBuilder("{");
        b.append(jsonField("status", r != null ? "ok" : "degraded"));
        b.append(',').append(jsonField("modsDir", MODS_DIR));
        b.append(',').append(jsonNum("modCount", MOD_COUNT));
        b.append(',').append(jsonBool("owoLoaded", r != null));
        if (r != null) {
            b.append(',').append(jsonNum("requiredChannels", r.requiredChannels.size()));
            b.append(',').append(jsonNum("requiredControllers", r.requiredControllers.size()));
            b.append(',').append(jsonNum("optionalChannels", r.optionalChannels.size()));
        }
        b.append('}');
        respond(ex, 200, b.toString());
    }

    private static void handleOwoHashes(HttpExchange ex) throws IOException {
        OwoIntrospector.Result r = OWO.get();
        if (r == null) {
            respond(ex, 503, "{\"error\":\"introspection failed; see daemon log\"}");
            return;
        }
        StringBuilder b = new StringBuilder("{");
        appendMap(b, "requiredChannels", r.requiredChannels);
        b.append(",");
        appendMap(b, "requiredControllers", r.requiredControllers);
        b.append(",");
        appendMap(b, "optionalChannels", r.optionalChannels);
        b.append("}");
        respond(ex, 200, b.toString());
    }

    private static void handleOwoDebug(HttpExchange ex) throws IOException {
        OwoIntrospector.Result r = OWO.get();
        String path = ex.getRequestURI().getPath(); // /owo/debug or /owo/debug/<channelId>
        String tail = path.length() > "/owo/debug".length() ? path.substring("/owo/debug/".length()) : "";
        if (r == null) { respond(ex, 503, "{\"error\":\"no introspection\"}"); return; }

        if (tail.isEmpty()) {
            // Dump raw scan log entries
            StringBuilder b = new StringBuilder("{\"scanLog\":[");
            for (int i = 0; i < r.scanLog.size(); i++) {
                if (i > 0) b.append(',');
                b.append('"').append(jsonEscape(r.scanLog.get(i))).append('"');
            }
            b.append("]}");
            respond(ex, 200, b.toString());
            return;
        }
        Integer h = r.requiredChannels.get(tail);
        if (h == null) h = r.requiredControllers.get(tail);
        if (h == null) h = r.optionalChannels.get(tail);
        if (h == null) { respond(ex, 404, "{\"error\":\"unknown channel\",\"id\":\"" + jsonEscape(tail) + "\"}"); return; }
        respond(ex, 200, "{\"id\":\"" + jsonEscape(tail) + "\",\"hash\":" + h + "}");
    }

    // ---- helpers ----
    private static String jsonField(String k, String v) { return "\"" + k + "\":\"" + jsonEscape(v) + "\""; }
    private static String jsonNum(String k, long v)     { return "\"" + k + "\":" + v; }
    private static String jsonBool(String k, boolean v) { return "\"" + k + "\":" + v; }

    static String jsonEscape(String s) {
        StringBuilder b = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.toString();
    }

    private static void appendMap(StringBuilder b, String name, Map<String, Integer> m) {
        b.append('"').append(name).append("\":{");
        boolean first = true;
        for (Map.Entry<String, Integer> e : m.entrySet()) {
            if (!first) b.append(',');
            first = false;
            b.append('"').append(jsonEscape(e.getKey())).append("\":").append(e.getValue());
        }
        b.append('}');
    }

    private static void respond(HttpExchange ex, int code, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }
}
