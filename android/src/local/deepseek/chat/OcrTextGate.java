package local.deepseek.chat;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Line-level text trigger, independent of scene motion and batch timers. A line is new when it is unlike
 * every line already seen and is read twice in a row or once with high confidence; short lines add up.
 */
final class OcrTextGate {
    static final float TRUSTED_CONFIDENCE = 80;
    private static final float MIN_CONFIDENCE = 60;
    private static final int MIN_KEY = 2, SHORT_KEY = 6, TRUSTED_KEY = 4, MIN_NOVEL = 4, CREDIT_READS = 8,
        WARMUP_READS = 2, MAX_SEEN = 400;
    private static final double JITTER = 0.5;

    private static final class Credit {
        final long read;
        final int novelty;
        final Set<String> pairs;
        Credit(long read, int novelty, Set<String> pairs) { this.read = read; this.novelty = novelty; this.pairs = pairs; }
    }
    private final Map<String, Set<String>> seen = new LinkedHashMap<String, Set<String>>(64, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, Set<String>> eldest) { return size() > MAX_SEEN; }
    };
    private final Map<String, Credit> credited = new LinkedHashMap<>();
    private Map<String, Set<String>> previous = new HashMap<>(), pending = new HashMap<>();
    private long reads;
    private int warm;

    static String cleanLine(String raw, float confidence) {
        if (raw == null || !Float.isFinite(confidence) || confidence < MIN_CONFIDENCE) return "";
        String spaced = raw.trim().replaceAll("\\s+", " ");
        // Keep "……", "！！！" and "哈哈哈" readable at three; long Latin runs are texture noise.
        StringBuilder line = new StringBuilder(spaced.length());
        int run = 0;
        for (int i = 0; i < spaced.length(); i++) {
            char c = spaced.charAt(i);
            run = i > 0 && c == spaced.charAt(i - 1) ? run + 1 : 1;
            if (run >= 5 && latin(c)) return "";
            if (run <= 3) line.append(c);
        }
        int cjk = 0, latin = 0, valid = 0, visible = 0;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (c == '\ufffd' || Character.isSurrogate(c) || Character.getType(c) == Character.PRIVATE_USE) return "";
            if (Character.isWhitespace(c) || prosePunctuation(c)) continue;
            visible++;
            if (c >= '\u3400' && c <= '\u9fff') { cjk++; valid++; }
            else if (latin(c)) { latin++; valid++; }
            else if (Character.isDigit(c)) valid++;
        }
        return (cjk >= 2 || latin >= 3) && valid >= visible * 0.65 ? line.toString() : "";
    }
    private static boolean latin(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
    /** Chinese and fullwidth punctuation is part of normal prose, not symbol noise. */
    private static boolean prosePunctuation(char c) {
        return c == '\u00b7' || (c >= '\u2010' && c <= '\u2027') || (c >= '\u3000' && c <= '\u303f')
            || (c >= '\uff01' && c <= '\uff0f') || (c >= '\uff1a' && c <= '\uff20')
            || (c >= '\uff3b' && c <= '\uff40') || (c >= '\uff5b' && c <= '\uff65');
    }

    /** Clocks, counters and punctuation do not make a line new. */
    static String key(String line) {
        return line.replaceAll("\\p{Nd}+", "0").replaceAll("[\\p{P}\\p{S}\\p{Z}\\s]+", "").toLowerCase(Locale.ROOT);
    }

    void reset() {
        seen.clear(); credited.clear(); previous = new HashMap<>(); pending = new HashMap<>(); reads = 0; warm = 0;
    }

    boolean offer(String text, Set<String> trusted, double threshold) {
        reads++;
        Map<String, Set<String>> current = new LinkedHashMap<>();
        Set<String> sure = new HashSet<>();
        for (String line : text.split("\\n")) {
            String key = key(line);
            if (key.length() < MIN_KEY) continue;
            current.put(key, pairs(key));
            if (trusted.contains(line)) sure.add(key);
        }
        previous = current;
        // The screen at the start of observation is context, not news.
        if (warm < WARMUP_READS) {
            if (!current.isEmpty()) warm++;
            seen.putAll(current);
            return false;
        }
        Map<String, Set<String>> last = pending;
        pending = new HashMap<>();
        for (Map.Entry<String, Set<String>> entry : current.entrySet()) {
            String key = entry.getKey();
            Set<String> pairs = entry.getValue();
            if (seen.get(key) != null || credited.containsKey(key)) continue;
            Set<String> nearest = nearest(pairs);
            if (misread(key) || (nearest != null && difference(pairs, nearest) < threshold)) {
                // Learn variants too: warm-up reads may hold only misread copies of a line.
                seen.put(key, pairs);
                continue;
            }
            // A one-off misread rarely repeats. Confirm against lines that were also new in the last read, since a
            // misread can resemble the correct reading of a known line; confident lines that are not tiny need no repeat.
            pending.put(key, pairs);
            if (!(sure.contains(key) && key.length() >= TRUSTED_KEY) && !near(pairs, last)) continue;
            int novelty = 0;
            for (String pair : pairs) if (nearest == null || !nearest.contains(pair)) novelty++;
            credited.put(key, new Credit(reads, novelty, pairs));
        }
        int novelty = 0;
        for (Iterator<Map.Entry<String, Credit>> it = credited.entrySet().iterator(); it.hasNext(); ) {
            Map.Entry<String, Credit> entry = it.next();
            if (reads - entry.getValue().read < CREDIT_READS) { novelty += entry.getValue().novelty; continue; }
            seen.put(entry.getKey(), entry.getValue().pairs);
            it.remove();
        }
        return novelty >= MIN_NOVEL;
    }

    /** Lines sent to the model become known, as do new lines that were credited but not sent yet. */
    void commit() {
        seen.putAll(previous);
        for (Map.Entry<String, Credit> entry : credited.entrySet()) seen.put(entry.getKey(), entry.getValue().pairs);
        credited.clear();
        pending = new HashMap<>();
    }

    private Set<String> nearest(Set<String> pairs) {
        Set<String> best = null;
        double distance = 2;
        for (Set<String> known : seen.values()) {
            double d = difference(pairs, known);
            if (d < distance) { distance = d; best = known; }
        }
        for (Credit credit : credited.values()) {
            double d = difference(pairs, credit.pairs);
            if (d < distance) { distance = d; best = credit.pairs; }
        }
        return best;
    }
    /** Bigrams cannot tell one misread character from new text in very short lines. */
    private boolean misread(String key) {
        if (key.length() > SHORT_KEY) return false;
        for (String known : seen.keySet()) if (oneEdit(key, known)) return true;
        for (String known : credited.keySet()) if (oneEdit(key, known)) return true;
        return false;
    }
    private static boolean oneEdit(String a, String b) {
        if (a.length() < b.length()) { String swap = a; a = b; b = swap; }
        if (a.length() - b.length() > 1) return false;
        int i = 0, j = 0, edits = 0;
        while (i < a.length() && j < b.length()) {
            if (a.charAt(i) == b.charAt(j)) { i++; j++; continue; }
            if (++edits > 1) return false;
            i++;
            if (a.length() == b.length()) j++;
        }
        return edits + a.length() - i <= 1;
    }
    private static boolean near(Set<String> pairs, Map<String, Set<String>> lines) {
        for (Set<String> other : lines.values()) if (difference(pairs, other) <= JITTER) return true;
        return false;
    }
    private static Set<String> pairs(String key) {
        Set<String> pairs = new HashSet<>();
        for (int i = 0; i < key.length(); i++) pairs.add(key.substring(i, Math.min(key.length(), i + 2)));
        return pairs;
    }
    private static double difference(Set<String> a, Set<String> b) {
        int shared = 0;
        for (String pair : a) if (b.contains(pair)) shared++;
        int union = a.size() + b.size() - shared;
        return union == 0 ? 0 : 1.0 - (double) shared / union;
    }
}
