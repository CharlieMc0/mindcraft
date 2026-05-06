package com.mindcraft.dumper;

import net.fabricmc.api.DedicatedServerModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Map;

/**
 * Server-side mod that, after server start, dumps every owo channel's
 * server-side state — channel ID, every serializersByIndex entry (key + record
 * class name), and the canonical hashChannel result computed by owo itself.
 *
 * Output is printed to the server log so we can compare against the bridge's
 * static-analysis reconstruction.
 */
public final class ChannelHashDumper implements DedicatedServerModInitializer {

    @Override
    public void onInitializeServer() {
        ServerLifecycleEvents.SERVER_STARTED.register((server) -> {
            try {
                dump();
            } catch (Throwable t) {
                System.err.println("[CH-DUMP] FAILED: " + t);
                t.printStackTrace();
            }
            try {
                RegistryDumper.dump();
            } catch (Throwable t) {
                System.err.println("[REG-DUMP] FAILED: " + t);
                t.printStackTrace();
            }
            // CHDUMP_DISABLE_FROZENLIB=1 sets ServerRegistrySync.forceDisable=true, which
            // makes requiresSync() return false. Useful when a client can't satisfy the
            // registry sync handshake — server still runs the dance but case-1 no longer
            // kicks on syncVersion=-1.
            if ("1".equals(System.getenv("CHDUMP_DISABLE_FROZENLIB"))) {
                try {
                    disableFrozenlibSync();
                } catch (Throwable t) {
                    System.err.println("[CH-DUMP] frozenlib disable FAILED: " + t);
                }
            }
        });
    }

    private void disableFrozenlibSync() throws Exception {
        Class<?> cls = Class.forName("org.quiltmc.qsl.frozenblock.core.registry.impl.sync.server.ServerRegistrySync");
        Field f = cls.getDeclaredField("forceDisable");
        f.setAccessible(true);
        f.setBoolean(null, true);
        System.out.println("[CH-DUMP] frozenlib registry sync disabled (forceDisable=true)");
    }

    private void dump() throws Exception {
        Class<?> clsCh = Class.forName("io.wispforest.owo.network.OwoNetChannel");
        Class<?> clsCtl = Class.forName("io.wispforest.owo.particles.systems.ParticleSystemController");

        Field fldRequired = clsCh.getDeclaredField("REQUIRED_CHANNELS");
        fldRequired.setAccessible(true);
        Map<?, ?> required = (Map<?, ?>) fldRequired.get(null);

        Field fldOptional = clsCh.getDeclaredField("OPTIONAL_CHANNELS");
        fldOptional.setAccessible(true);
        Map<?, ?> optional = (Map<?, ?>) fldOptional.get(null);

        Field fldRegCtl = clsCtl.getDeclaredField("REGISTERED_CONTROLLERS");
        fldRegCtl.setAccessible(true);
        Map<?, ?> ctlRegistry = (Map<?, ?>) fldRegCtl.get(null);

        Field fldSerByIdx = clsCh.getDeclaredField("serializersByIndex");
        fldSerByIdx.setAccessible(true);
        Field fldPacketId = clsCh.getDeclaredField("packetId");
        fldPacketId.setAccessible(true);

        Field fldChIdCtl = clsCtl.getDeclaredField("channelId");
        fldChIdCtl.setAccessible(true);
        Field fldSysByIdx = clsCtl.getDeclaredField("systemsByIndex");
        fldSysByIdx.setAccessible(true);

        System.out.println("[CH-DUMP] === REQUIRED CHANNELS ===");
        dumpChannelMap(required, fldSerByIdx, fldPacketId, "required");
        System.out.println("[CH-DUMP] === OPTIONAL CHANNELS ===");
        dumpChannelMap(optional, fldSerByIdx, fldPacketId, "optional");
        System.out.println("[CH-DUMP] === CONTROLLERS ===");
        dumpControllerMap(ctlRegistry, fldChIdCtl, fldSysByIdx);
        System.out.println("[CH-DUMP] === DONE ===");
    }

    /**
     * Compute hash exactly per OwoHandshake.hashChannel bytecode:
     *   serializersHash += entry.getIntKey() * 31 + entry.getValue().getRecordClass().getName().hashCode()
     *   return 31 * channel.packetId.hashCode() + serializersHash
     */
    private static void dumpChannelMap(Map<?, ?> m, Field serByIdx, Field packetIdF, String tag)
            throws Exception {
        for (Map.Entry<?, ?> e : m.entrySet()) {
            Object id = e.getKey();
            Object channel = e.getValue();
            Object packetId = packetIdF.get(channel);
            Map<?, ?> idxMap = (Map<?, ?>) serByIdx.get(channel);
            int sum = 0;
            System.out.println(String.format("[CH-DUMP] %s channel=%s pidHash=%d (entries=%d)",
                    tag, id, packetId.hashCode(), idxMap.size()));
            for (Map.Entry<?, ?> ie : idxMap.entrySet()) {
                int key = ((Integer) ie.getKey()).intValue();
                Object indexedSer = ie.getValue();
                String cls = "?";
                int contrib = 0;
                try {
                    Field s = indexedSer.getClass().getDeclaredField("serializer");
                    s.setAccessible(true);
                    Object ser = s.get(indexedSer);
                    Method m2 = ser.getClass().getMethod("getRecordClass");
                    Class<?> r = (Class<?>) m2.invoke(ser);
                    cls = r.getName();
                    contrib = key * 31 + cls.hashCode();
                    sum += contrib;
                } catch (Throwable t) {
                    cls = "<reflect-fail:" + t.getClass().getSimpleName() + ":" + t.getMessage() + ">";
                }
                System.out.println(String.format("[CH-DUMP]   [%d] %s contrib=%d", key, cls, contrib));
            }
            int hash = 31 * packetId.hashCode() + sum;
            System.out.println(String.format("[CH-DUMP] %s channel=%s hash=%d", tag, id, hash));
        }
    }

    /** controller hash = 31 * channelId.hashCode() + sum(systemIndex). */
    private static void dumpControllerMap(Map<?, ?> m, Field chIdF, Field sysByIdxF) throws Exception {
        for (Map.Entry<?, ?> e : m.entrySet()) {
            Object id = e.getKey();
            Object ctl = e.getValue();
            Object channelId = chIdF.get(ctl);
            Map<?, ?> sys = (Map<?, ?>) sysByIdxF.get(ctl);
            int sum = 0;
            for (Object k : sys.keySet()) sum += ((Integer) k).intValue();
            int hash = 31 * channelId.hashCode() + sum;
            System.out.println(String.format("[CH-DUMP] controller=%s hash=%d (systems=%d)",
                    id, hash, sys.size()));
        }
    }
}
