package com.mindcraft.dumper;

import net.minecraft.class_2378;
import net.minecraft.class_2960;
import net.minecraft.class_7923;

import java.io.FileWriter;
import java.io.IOException;
import java.io.Writer;
import java.nio.file.Path;

/**
 * Dumps the server's Block and Item registries to a JSON file on SERVER_STARTED.
 * The bridge daemon reads this file to expose `/registry/blocks` and
 * `/registry/items` so the bot can resolve modded numeric IDs to their
 * `modid:path` registry IDs.
 *
 * Output path: env var CHDUMP_REGISTRY_PATH, else $TMPDIR/mindcraft-modcompat-registry.json.
 *
 * Format:
 *   { "blocks": { "<rawId>": "<modid:path>", ... },
 *     "items":  { "<rawId>": "<modid:path>", ... } }
 */
public final class RegistryDumper {

    public static void dump() {
        Path out = resolvePath();
        try (Writer w = new FileWriter(out.toFile())) {
            w.write("{\"blocks\":");
            writeRegistry(w, class_7923.field_41175);
            w.write(",\"items\":");
            writeRegistry(w, class_7923.field_41178);
            w.write("}");
            System.out.println("[REG-DUMP] wrote " + out);
        } catch (IOException e) {
            System.err.println("[REG-DUMP] FAILED: " + e);
        }
    }

    private static Path resolvePath() {
        String env = System.getenv("CHDUMP_REGISTRY_PATH");
        if (env != null && !env.isEmpty()) return Path.of(env);
        return Path.of(System.getProperty("java.io.tmpdir"), "mindcraft-modcompat-registry.json");
    }

    private static <T> void writeRegistry(Writer w, class_2378<T> reg) throws IOException {
        w.write("{");
        boolean first = true;
        for (T entry : reg) {
            class_2960 id = reg.method_10221(entry);
            int rawId = reg.method_10206(entry);
            if (id == null) continue;
            if (!first) w.write(",");
            first = false;
            w.write("\"");
            w.write(Integer.toString(rawId));
            w.write("\":\"");
            w.write(escape(id.toString()));
            w.write("\"");
        }
        w.write("}");
    }

    private static String escape(String s) {
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
}
