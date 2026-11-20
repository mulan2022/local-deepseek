package local.deepseek.chat;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** Compressed images live only here. A claimed batch is pinned until its model round finishes. */
final class OcrFrameBuffer {
    static final int MAX_FRAMES = 100;
    static final long MAX_BYTES = 64L * 1024 * 1024;
    static final class Frame {
        final String id;
        final long at;
        final String text;
        final byte[] jpeg;
        Frame(String id, long at, String text, byte[] jpeg) {
            this.id = id; this.at = at; this.text = text; this.jpeg = jpeg;
        }
    }
    static final class Batch {
        final String id;
        final String sessionId;
        final List<Frame> frames;
        Batch(String sessionId, List<Frame> frames) {
            this.id = "ocr:" + UUID.randomUUID();
            this.sessionId = sessionId;
            this.frames = frames;
        }
    }
    private final LinkedHashMap<String, Frame> pending = new LinkedHashMap<>();
    private final String prefix = UUID.randomUUID().toString().substring(0, 8);
    private long sequence;
    private long bytes;
    private int chars;
    private Batch active;

    synchronized boolean add(long at, String text, byte[] jpeg) {
        if (jpeg.length > MAX_BYTES) return false;
        while ((size() >= MAX_FRAMES || bytes + jpeg.length > MAX_BYTES) && !pending.isEmpty()) {
            Iterator<Frame> it = pending.values().iterator();
            Frame removed = it.next(); it.remove();
            bytes -= removed.jpeg.length;
            chars -= removed.text.length();
        }
        if (size() >= MAX_FRAMES || bytes + jpeg.length > MAX_BYTES) return false;
        String id = prefix + "-" + (++sequence);
        String bounded = text.length() > 6000 ? text.substring(0, 6000) : text;
        pending.put(id, new Frame(id, at, bounded, jpeg));
        bytes += jpeg.length; chars += bounded.length();
        return true;
    }
    synchronized Batch claim(String sessionId, long now, int threshold, long waitMillis) {
        if (active != null) return active.sessionId.equals(sessionId) ? active : null;
        if (pending.isEmpty()) return null;
        if (chars < threshold && now - pending.values().iterator().next().at < waitMillis
                && pending.size() < MAX_FRAMES) return null;
        List<Frame> frames = new ArrayList<>();
        int selectedChars = 0;
        Iterator<Frame> it = pending.values().iterator();
        while (it.hasNext()) {
            Frame frame = it.next(); it.remove(); frames.add(frame);
            chars -= frame.text.length(); selectedChars += frame.text.length();
            if (selectedChars >= threshold) break;
        }
        active = new Batch(sessionId, frames);
        return active;
    }
    synchronized Batch active(String sessionId) {
        return active != null && active.sessionId.equals(sessionId) ? active : null;
    }
    synchronized byte[] image(String batchId, String imageId, String sessionId) {
        if (active == null || !active.id.equals(batchId) || !active.sessionId.equals(sessionId)) return null;
        for (Frame frame : active.frames) if (frame.id.equals(imageId)) return frame.jpeg;
        return null;
    }
    synchronized boolean complete(String id) {
        if (active == null || !active.id.equals(id)) return false;
        for (Frame frame : active.frames) bytes -= frame.jpeg.length;
        active = null;
        return true;
    }
    synchronized void clear() { pending.clear(); active = null; bytes = 0; chars = 0; }
    synchronized int size() { return pending.size() + (active == null ? 0 : active.frames.size()); }
    synchronized long bytes() { return bytes; }

    static String normalize(String text) {
        return text.replaceAll("\\d{1,2}:\\d{2}(?::\\d{2})?", "")
            .replaceAll("[\\p{P}\\p{Z}\\s]+", "").toLowerCase(java.util.Locale.ROOT);
    }
    private static Set<String> pairs(String text) {
        Set<String> pairs = new HashSet<>();
        for (int i = 0; i < text.length(); i++) pairs.add(text.substring(i, Math.min(text.length(), i + 2)));
        return pairs;
    }
    static double difference(String left, String right) {
        if (left.equals(right)) return 0;
        Set<String> a = pairs(left), b = pairs(right), union = new HashSet<>(a);
        union.addAll(b); a.retainAll(b);
        return union.isEmpty() ? 0 : 1.0 - (double) a.size() / union.size();
    }
    static boolean changedLine(String before, String after, double threshold) {
        Set<String> old = new HashSet<>();
        if (before != null) for (String line : before.split("\\r?\\n")) {
            String value = normalize(line);
            if (value.length() >= 6 && value.length() <= 400) old.add(value);
            if (old.size() >= 128) break;
        }
        int checked = 0;
        for (String line : after.split("\\r?\\n")) {
            String value = normalize(line);
            if (value.length() < 6 || value.length() > 400 || value.matches("\\d+") || old.contains(value)) continue;
            if (++checked > 128) break;
            boolean similar = false;
            for (String previous : old) {
                if (difference(previous, value) < threshold) { similar = true; break; }
            }
            if (!similar) return true;
        }
        return false;
    }
}
