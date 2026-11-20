package local.deepseek.chat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;
import android.view.WindowManager;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

public final class ScreenCaptureService extends Service {
    static final String START = "local.deepseek.chat.CAPTURE";
    static final String STOP = "local.deepseek.chat.STOP_CAPTURE";
    static final String DATA = "capture-data";
    static final String RESULT = "capture-result";
    static final String FOLDER = "capture-folder";
    private static final String CHANNEL = "screen_capture";
    private static final int NOTIFICATION = 1841;
    private static final int MAX_EDGE = 1280;
    private static volatile ScreenCaptureService current;

    private MediaProjection projection;
    private MediaProjection.Callback projectionCallback;
    private VirtualDisplay display;
    private ImageReader reader;
    private HandlerThread frameThread;
    private Image lastImage;
    private String folderId = PhoneToolsBridge.DEFAULT_FOLDER;
    private boolean contentVisible = true;
    private boolean blankFrame;

    static boolean active() { return current != null; }

    static void refreshObserver() {
        ScreenCaptureService service = current;
        refreshObserver(service == null ? PhoneToolsBridge.DEFAULT_FOLDER : service.folderId);
    }

    static void refreshObserver(String folderId) {
        String selected = PhoneToolsBridge.folder(folderId);
        new Handler(Looper.getMainLooper()).post(() -> {
            ScreenCaptureService service = current;
            if (service != null) ScreenObserver.start(service, selected);
            else ScreenObserver.stop();
        });
    }

    synchronized Bitmap readBitmap() {
        // Read the shared frame as rendered, without changing overlay visibility or focus.
        if (reader == null || current != this || !contentVisible || ChatWebView.isFullChatVisible()) return null;
        keepLatestFrame(reader);
        if (lastImage == null) return null;
        Bitmap padded = null;
        Bitmap visible = null;
        try {
            Image.Plane plane = lastImage.getPlanes()[0];
            Rect crop = lastImage.getCropRect();
            if (!crop.intersect(0, 0, lastImage.getWidth(), lastImage.getHeight())) return null;
            padded = Bitmap.createBitmap(plane.getRowStride() / plane.getPixelStride(),
                lastImage.getHeight(), Bitmap.Config.ARGB_8888);
            ByteBuffer pixels = plane.getBuffer().duplicate();
            if (pixels.remaining() < padded.getByteCount()) {
                ByteBuffer withPadding = ByteBuffer.allocate(padded.getByteCount());
                withPadding.put(pixels).rewind(); pixels = withPadding;
            }
            padded.copyPixelsFromBuffer(pixels);
            visible = Bitmap.createBitmap(padded, crop.left, crop.top, crop.width(), crop.height());
            if (isBlank(visible)) { blankFrame = true; if (visible != padded) visible.recycle(); return null; }
            if (visible == padded) { padded = null; }
            return visible;
        } catch (RuntimeException failed) {
            if (visible != null && visible != padded) visible.recycle();
            return null;
        } finally {
            if (padded != null) padded.recycle();
        }
    }

    static String frame() {
        ScreenCaptureService service = current;
        return service == null ? "" : service.readFrame();
    }

    static String status(android.content.Context context) {
        return status(context, PhoneToolsBridge.currentFolder(context));
    }

    static String status(android.content.Context context, String folderId) {
        ScreenCaptureService service = current;
        return service == null ? PhoneToolsBridge.prefs(context, folderId).getString("captureStoppedStatus", "inactive")
            : service.frameStatus();
    }

    static String message(android.content.Context context) {
        return message(context, PhoneToolsBridge.currentFolder(context));
    }

    static String message(android.content.Context context, String folderId) {
        switch (status(context, folderId)) {
            case "chat_visible": return "请先进入悬浮球模式或切到目标应用，避免把聊天界面再次截给 AI。";
            case "ready": return "屏幕共享进行中，可连续截图。";
            case "waiting": return "屏幕共享已授权，正在等待画面。";
            case "hidden": return "屏幕共享仍有效，但共享的应用当前不可见。请切回目标应用。";
            case "blank": return "屏幕共享仍有效，但当前画面全黑或全白。请检查目标应用是否允许截屏。";
            default: return PhoneToolsBridge.prefs(context, folderId).getString("captureStoppedMessage", "尚未授权屏幕共享。");
        }
    }

    private void endCapture(String status, String message) {
        PhoneToolsBridge.prefs(this, folderId).edit().putString("captureStoppedStatus", status)
            .putString("captureStoppedMessage", message).apply();
        closeProjection();
        stopSelf();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            endCapture("stopped", "屏幕共享已停止，需要使用时请重新授权。");
            return START_NOT_STICKY;
        }
        if (intent != null && START.equals(intent.getAction())) {
            folderId = PhoneToolsBridge.folder(intent.getStringExtra(FOLDER));
        }
        if (intent == null || !PhoneToolsBridge.prefs(this, folderId).getBoolean("capture", false)) {
            endCapture("stopped", "屏幕共享服务已停止，需要使用时请重新授权。");
            return START_NOT_STICKY;
        }
        // A duplicate or unrelated service intent must not consume another token or stop an active session.
        if (!START.equals(intent.getAction()) || (current == this && projection != null)) {
            return START_NOT_STICKY;
        }
        closeProjection();
        try {
            startForeground(NOTIFICATION, notification());
            Intent data = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableExtra(DATA, Intent.class) : intent.getParcelableExtra(DATA);
            MediaProjectionManager manager = getSystemService(MediaProjectionManager.class);
            projection = manager.getMediaProjection(intent.getIntExtra(RESULT, 0), data);
            if (projection == null) {
                endCapture("error", "未能建立屏幕共享，请重新授权。");
                return START_NOT_STICKY;
            }
            final MediaProjection session = projection;
            projectionCallback = new MediaProjection.Callback() {
                @Override public void onStop() {
                    if (projection != session) return;
                    endCapture("revoked", "系统已结束屏幕共享，请重新授权。锁屏、其他录屏或系统停止共享都可能导致中断。");
                }
                @Override public void onCapturedContentResize(int width, int height) {
                    if (projection != session) return;
                    resize(width, height);
                }
                @Override public void onCapturedContentVisibilityChanged(boolean visible) {
                    if (projection != session) return;
                    setContentVisible(visible);
                }
            };
            projection.registerCallback(projectionCallback, new Handler(Looper.getMainLooper()));
            frameThread = new HandlerThread("PhoneCapture");
            frameThread.start();
            Rect bounds = displayBounds();
            createDisplay(bounds.width(), bounds.height());
            PhoneToolsBridge.prefs(this, folderId).edit().remove("captureStoppedStatus").remove("captureStoppedMessage").apply();
            current = this;
            ScreenObserver.start(this, folderId);
            HeartbeatJob.resumeLocalSchedule(this);
        } catch (RuntimeException failed) {
            Log.w("PhoneCapture", "Could not start screen sharing", failed);
            endCapture("error", "屏幕共享启动失败，请回到应用重新授权。");
        }
        return START_NOT_STICKY;
    }

    private Notification notification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Screen capture",
            NotificationManager.IMPORTANCE_LOW));
        PendingIntent stop = PendingIntent.getService(this, NOTIFICATION,
            new Intent(this, ScreenCaptureService.class).setAction(STOP),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent open = PendingIntent.getActivity(this, NOTIFICATION,
            new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentTitle("屏幕捕获已授权")
            .setContentText("共享持续到你停止或系统中断；切换应用可继续截图。")
            .setContentIntent(open)
            .addAction(new Notification.Action.Builder(null, "停止捕获", stop).build())
            .setOngoing(true)
            .build();
    }

    private static int[] dimensions(int width, int height) {
        double scale = Math.min(1.0, (double) MAX_EDGE / Math.max(width, height));
        return new int[] { Math.max(1, (int) Math.round(width * scale)), Math.max(1, (int) Math.round(height * scale)) };
    }

    private Rect displayBounds() {
        DisplayManager manager = getSystemService(DisplayManager.class);
        Display screen = manager.getDisplay(Display.DEFAULT_DISPLAY);
        if (Build.VERSION.SDK_INT >= 30 && screen != null) {
            return createDisplayContext(screen).createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION, null)
                .getSystemService(WindowManager.class).getMaximumWindowMetrics().getBounds();
        }
        DisplayMetrics metrics = new DisplayMetrics();
        getSystemService(WindowManager.class).getDefaultDisplay().getRealMetrics(metrics);
        return new Rect(0, 0, metrics.widthPixels, metrics.heightPixels);
    }

    private synchronized void createDisplay(int width, int height) {
        reader = newReader(width, height);
        display = projection.createVirtualDisplay("Local chat screen", width, height, getResources().getDisplayMetrics().densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, null);
        if (display == null) throw new IllegalStateException("Capture display unavailable");
    }

    private ImageReader newReader(int width, int height) {
        ImageReader next = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3);
        next.setOnImageAvailableListener(this::keepLatestFrame, new Handler(frameThread.getLooper()));
        return next;
    }

    private synchronized void keepLatestFrame(ImageReader source) {
        if (source != reader) return;
        try {
            Image next = source.acquireLatestImage();
            if (next == null) return;
            if (!contentVisible) {
                next.close();
                return;
            }
            clearFrame();
            lastImage = next;
        } catch (IllegalStateException ignored) {}
    }

    private void clearFrame() {
        if (lastImage != null) lastImage.close();
        lastImage = null;
        blankFrame = false;
    }

    private synchronized void setContentVisible(boolean visible) {
        if (contentVisible == visible) return;
        contentVisible = visible;
        clearFrame();
        if (reader != null) {
            try (Image ignored = reader.acquireLatestImage()) {} catch (IllegalStateException ignored) {}
        }
    }

    private synchronized void resize(int width, int height) {
        if (display == null || width < 1 || height < 1) return;
        if (reader.getWidth() == width && reader.getHeight() == height) return;
        ImageReader next = newReader(width, height);
        try {
            display.resize(width, height, getResources().getDisplayMetrics().densityDpi);
            display.setSurface(next.getSurface());
        } catch (RuntimeException failed) {
            next.close();
            Log.w("PhoneCapture", "Could not resize shared screen", failed);
            endCapture("error", "屏幕尺寸切换失败，请重新授权屏幕共享。");
            return;
        }
        clearFrame();
        reader.close();
        reader = next;
    }

    @Override public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        if (Build.VERSION.SDK_INT < 34) {
            Rect bounds = displayBounds();
            resize(bounds.width(), bounds.height());
        }
    }

    private String readFrame() {
        Bitmap image = readBitmap();
        if (image == null) return "";
        Bitmap scaled = image;
        try {
            int[] size = dimensions(image.getWidth(), image.getHeight());
            scaled = Bitmap.createScaledBitmap(image, size[0], size[1], true);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            return scaled.compress(Bitmap.CompressFormat.JPEG, 85, bytes)
                ? Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP) : "";
        } finally {
            if (scaled != image) scaled.recycle();
            image.recycle();
        }
    }

    private static boolean isBlank(Bitmap bitmap) {
        int width = bitmap.getWidth();
        int[] row = new int[width];
        int first = bitmap.getPixel(0, 0) & 0x00ffffff;
        if (first != 0 && first != 0x00ffffff) return false;
        for (int y = 0; y < bitmap.getHeight(); y++) {
            bitmap.getPixels(row, 0, width, 0, y, width, 1);
            for (int pixel : row) {
                if ((pixel & 0x00ffffff) != first) return false;
            }
        }
        return true;
    }

    private synchronized String frameStatus() {
        if (current != this) return "inactive";
        if (!contentVisible) return "hidden";
        if (ChatWebView.isFullChatVisible()) return "chat_visible";
        return blankFrame ? "blank" : lastImage == null ? "waiting" : "ready";
    }

    private synchronized void closeProjection() {
        if (current == this) ScreenObserver.stop();
        if (current == this) current = null;
        contentVisible = true;
        if (display != null) display.release();
        clearFrame();
        if (reader != null) reader.close();
        if (projection != null) {
            if (projectionCallback != null) projection.unregisterCallback(projectionCallback);
            projection.stop();
        }
        if (frameThread != null) frameThread.quitSafely();
        display = null;
        reader = null;
        projection = null;
        projectionCallback = null;
        frameThread = null;
    }

    @Override public void onDestroy() {
        if (current == this) {
            PhoneToolsBridge.prefs(this, folderId).edit().putString("captureStoppedStatus", "stopped")
                .putString("captureStoppedMessage", "屏幕共享服务已停止，需要使用时请重新授权。").apply();
        }
        closeProjection();
        super.onDestroy();
    }
}
