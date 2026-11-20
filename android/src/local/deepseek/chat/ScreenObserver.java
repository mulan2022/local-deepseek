package local.deepseek.chat;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.graphics.RectF;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import com.googlecode.tesseract.android.TessBaseAPI;
import com.googlecode.tesseract.android.ResultIterator;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/** One offline OCR worker; slow recognition drops sampling ticks rather than building a backlog. */
final class ScreenObserver {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static volatile ScreenObserver current;
    private final Context context;
    private final ScreenCaptureService capture;
    private final String folderId;
    private final OcrFrameBuffer buffer = new OcrFrameBuffer();
    private final HandlerThread thread = new HandlerThread("LocalScreenOcr");
    private final AtomicBoolean closed = new AtomicBoolean();
    private Handler worker;
    private TessBaseAPI recognizer;
    private volatile String sessionId = "";
    private final OcrTextGate gate = new OcrTextGate();
    private int reads, changes;
    private volatile String message = "等待开启 OCR 观察";

    private ScreenObserver(ScreenCaptureService capture, String folderId) {
        this.capture = capture; this.context = capture.getApplicationContext();
        this.folderId = PhoneToolsBridge.folder(folderId);
        thread.start(); worker = new Handler(thread.getLooper());
    }
    static void start(ScreenCaptureService capture) {
        start(capture, PhoneToolsBridge.currentFolder(capture));
    }
    static void start(ScreenCaptureService capture, String folderId) {
        stop();
        if (!PhoneToolsBridge.prefs(capture, folderId).getBoolean("ocr", false)) return;
        ScreenObserver next = new ScreenObserver(capture, folderId);
        current = next;
        next.requestSample();
    }
    static void stop() {
        ScreenObserver old = current; current = null;
        if (old == null) return;
        old.closed.set(true);
        old.buffer.clear();
        old.worker.removeCallbacksAndMessages(null);
        old.worker.post(() -> {
            try { if (old.recognizer != null) old.recognizer.recycle(); }
            finally { old.thread.quitSafely(); }
        });
        MAIN.post(() -> { if (current == null) ChatWebView.observationChanged(old.context, false); });
    }
    static String status() {
        ScreenObserver observer = current;
        return observer == null ? "请先授权屏幕共享" : observer.message;
    }
    static int count() { ScreenObserver observer = current; return observer == null ? 0 : observer.buffer.size(); }
    static long bytes() { ScreenObserver observer = current; return observer == null ? 0 : observer.buffer.bytes(); }
    private boolean enabled() {
        return PhoneToolsBridge.prefs(context, folderId).getBoolean("ocr", false)
            && PhoneToolsBridge.prefs(context, folderId).getBoolean("capture", false) && !closed.get();
    }
    private static int setting(Context context, String folderId, String name, int fallback) {
        return PhoneToolsBridge.prefs(context, folderId).getInt(name, fallback);
    }
    private void init() throws Exception {
        File root = new File(context.getFilesDir(), "offline-ocr-v4.9.0");
        File data = new File(root, "tessdata");
        if (!data.isDirectory() && !data.mkdirs()) throw new IllegalStateException("Cannot create OCR model directory");
        for (String name : new String[]{"chi_sim.traineddata", "eng.traineddata"}) {
            File target = new File(data, name);
            long expected = name.startsWith("chi") ? 2469156 : 4113088;
            if (target.isFile() && target.length() == expected) continue;
            File partial = new File(data, name + ".part");
            try (InputStream input = context.getAssets().open("ocr/" + name);
                    FileOutputStream out = new FileOutputStream(partial)) {
                byte[] block = new byte[65536]; int read;
                while ((read = input.read(block)) != -1) out.write(block, 0, read);
            }
            if (partial.length() != expected || (target.exists() && !target.delete()) || !partial.renameTo(target))
                throw new IllegalStateException("Incomplete offline OCR model");
        }
        recognizer = new TessBaseAPI();
        if (!recognizer.init(root.getAbsolutePath(), "chi_sim+eng", TessBaseAPI.OEM_LSTM_ONLY)) {
            recognizer.recycle(); recognizer = null;
            throw new IllegalStateException("OCR model initialization failed");
        }
        recognizer.setPageSegMode(TessBaseAPI.PageSegMode.PSM_SPARSE_TEXT);
    }
    private void requestSample() {
        MAIN.post(() -> {
            if (current != this || closed.get()) return;
            if (enabled() && !PhoneToolsBridge.prefs(context, folderId).getString("ocrSessionId", "").isEmpty()) {
                ChatWebView.observationChanged(context, true);
            }
            List<RectF> overlays = FloatingChatWindow.observationRegions();
            worker.post(() -> tick(overlays));
        });
    }

    private void tick(List<RectF> overlays) {
        if (closed.get()) return;
        Bitmap image = null;
        try {
            if (!enabled()) {
                buffer.clear(); gate.reset(); sessionId = "";
                message = "OCR 观察未开启";
                MAIN.post(() -> {
                    if (current == this && !enabled()) ChatWebView.observationChanged(context, false);
                });
                return;
            }
            String selected = PhoneToolsBridge.prefs(context, folderId).getString("ocrSessionId", "");
            if (!sessionId.equals(selected)) {
                buffer.clear(); gate.reset(); sessionId = selected; reads = 0; changes = 0;
            }
            if (selected.isEmpty()) { message = "请选择接收 OCR 的会话"; return; }
            if (recognizer == null) { message = "正在初始化离线中文 OCR"; init(); }
            long capturedAt = System.currentTimeMillis();
            image = capture.readBitmap();
            if (image == null) { message = "等待可读取的共享画面"; return; }
            recognizer.setImage(image);
            StringBuilder reliable = new StringBuilder();
            Set<String> trusted = new HashSet<>();
            ResultIterator lines = null;
            try {
                recognizer.getUTF8Text();
                lines = recognizer.getResultIterator();
                if (lines != null) {
                    lines.begin();
                    do {
                        int level = TessBaseAPI.PageIteratorLevel.RIL_TEXTLINE;
                        float confidence = lines.confidence(level);
                        String line = OcrTextGate.cleanLine(lines.getUTF8Text(level), confidence);
                        if (!line.isEmpty() && (overlays.isEmpty() ||
                                !overlapsOverlay(lines.getBoundingRect(level), image, overlays))) {
                            reliable.append(line).append('\n');
                            if (confidence >= OcrTextGate.TRUSTED_CONFIDENCE) trusted.add(line);
                        }
                    } while (reliable.length() < 6000 && lines.next(TessBaseAPI.PageIteratorLevel.RIL_TEXTLINE));
                }
            } finally {
                if (lines != null) lines.delete();
                recognizer.clear();
            }
            String text = reliable.toString().trim();
            if (text.length() > 6000) text = text.substring(0, 6000);
            double threshold = PhoneToolsBridge.ocrChangePercent(context, folderId) / 100.0;
            reads++;
            if (gate.offer(text, trusted, threshold)) {
                ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
                double scale = Math.min(1.0, 1280.0 / Math.max(image.getWidth(), image.getHeight()));
                Bitmap compressed = Bitmap.createScaledBitmap(image, Math.max(1, (int)(image.getWidth() * scale)),
                    Math.max(1, (int)(image.getHeight() * scale)), true);
                try { compressed.compress(Bitmap.CompressFormat.JPEG, 75, jpeg); }
                finally { if (compressed != image) compressed.recycle(); }
                if (!closed.get() && enabled() && selected.equals(PhoneToolsBridge.prefs(context, folderId).getString("ocrSessionId", ""))
                        && buffer.add(capturedAt, text, jpeg.toByteArray())) {
                    gate.commit(); changes++;
                }
            }
            message = "本地 OCR 观察中 · 已识别 " + reads + " 次 · 新文字 " + changes + " 次 · 缓存 " + buffer.size() + "/100 张";
        } catch (Exception | LinkageError failed) {
            message = "离线 OCR 启动或识别失败，请检查模型文件或重新开启观察";
            Log.w("LocalScreenOcr", "Offline OCR failed", failed);
        } finally {
            if (image != null) image.recycle();
            if (!closed.get()) worker.postDelayed(this::requestSample,
                Math.max(1000, setting(context, folderId, "ocrIntervalSeconds", 1) * 1000L));
        }
    }

    private static boolean overlapsOverlay(Rect line, Bitmap image, List<RectF> overlays) {
        float width = image.getWidth();
        float height = image.getHeight();
        for (RectF overlay : overlays) {
            if (overlay.intersects(line.left / width, line.top / height, line.right / width, line.bottom / height)) {
                return true;
            }
        }
        return false;
    }
    static String pending(Context context) {
        return pending(context, PhoneToolsBridge.currentFolder(context));
    }
    static String pending(Context context, String folderId) {
        ScreenObserver observer = current;
        String selected = PhoneToolsBridge.folder(folderId);
        if (observer == null || !observer.folderId.equals(selected) || !observer.enabled()) return "null";
        String session = PhoneToolsBridge.prefs(context, selected).getString("ocrSessionId", "");
        if (session.isEmpty() || !observer.sessionId.equals(session)) return "null";
        OcrFrameBuffer.Batch batch = observer.buffer.claim(session, System.currentTimeMillis(),
            setting(context, selected, "ocrBatchChars", 500), setting(context, selected, "ocrWaitSeconds", 15) * 1000L);
        return json(batch, selected);
    }
    static String active(String session) {
        ScreenObserver observer = current;
        return observer == null || !observer.enabled() ? "null" : json(observer.buffer.active(session), observer.folderId);
    }
    private static String json(OcrFrameBuffer.Batch batch, String folderId) {
        if (batch == null) return "null";
        try {
            JSONArray frames = new JSONArray();
            for (OcrFrameBuffer.Frame frame : batch.frames)
                frames.put(new JSONObject().put("id", frame.id).put("at", frame.at).put("text", frame.text));
            return new JSONObject().put("id", batch.id).put("folderId", folderId).put("sessionId", batch.sessionId)
                .put("at", batch.frames.get(0).at).put("frames", frames).toString();
        } catch (Exception invalid) { return "null"; }
    }
    static String image(String batch, String id, String session) {
        ScreenObserver observer = current;
        byte[] jpeg = observer == null || !observer.enabled() ? null : observer.buffer.image(batch, id, session);
        return jpeg == null ? "" : Base64.encodeToString(jpeg, Base64.NO_WRAP);
    }
    static void complete(String batch, String state) {
        ScreenObserver observer = current;
        if (observer != null && !"busy".equals(state)) observer.buffer.complete(batch);
    }
}
