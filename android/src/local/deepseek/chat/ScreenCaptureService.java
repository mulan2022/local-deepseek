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
import android.view.Display;
import android.view.WindowManager;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

public final class ScreenCaptureService extends Service {
    static final String START = "local.deepseek.chat.CAPTURE";
    static final String STOP = "local.deepseek.chat.STOP_CAPTURE";
    static final String DATA = "capture-data";
    static final String RESULT = "capture-result";
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
    private String latest;
    private boolean contentVisible = true;
    private boolean blankFrame;

    static boolean active() { return current != null; }

    static String frame() {
        ScreenCaptureService service = current;
        return service == null ? "" : service.readFrame();
    }

    static String status() {
        ScreenCaptureService service = current;
        return service == null ? "inactive" : service.frameStatus();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || !START.equals(intent.getAction())
                || !PhoneToolsBridge.prefs(this).getBoolean("capture", false)) {
            stopSelf();
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
                stopSelf();
                return START_NOT_STICKY;
            }
            projectionCallback = new MediaProjection.Callback() {
                @Override public void onStop() {
                    closeProjection();
                    stopSelf();
                }
                @Override public void onCapturedContentResize(int width, int height) {
                    resize(width, height);
                }
                @Override public void onCapturedContentVisibilityChanged(boolean visible) {
                    setContentVisible(visible);
                }
            };
            projection.registerCallback(projectionCallback, new Handler(Looper.getMainLooper()));
            frameThread = new HandlerThread("PhoneCapture");
            frameThread.start();
            Rect bounds = displayBounds();
            createDisplay(bounds.width(), bounds.height());
            current = this;
            HeartbeatJob.resumeLocalSchedule(this);
        } catch (RuntimeException failed) {
            closeProjection();
            stopSelf();
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
        return new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentTitle("屏幕捕获已授权")
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
        latest = null;
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
            closeProjection();
            stopSelf();
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

    private synchronized String readFrame() {
        if (reader == null || current != this || !contentVisible) return "";
        keepLatestFrame(reader);
        if (blankFrame) return "";
        if (latest != null) return latest;
        Image image = lastImage;
        if (image == null) return "";
        try {
            Image.Plane plane = image.getPlanes()[0];
            Rect crop = image.getCropRect();
            if (!crop.intersect(0, 0, image.getWidth(), image.getHeight())) return "";
            int rowWidth = plane.getRowStride() / plane.getPixelStride();
            Bitmap padded = Bitmap.createBitmap(rowWidth, image.getHeight(), Bitmap.Config.ARGB_8888);
            Bitmap visible = padded;
            Bitmap scaled = padded;
            try {
                ByteBuffer pixels = plane.getBuffer().duplicate();
                if (pixels.remaining() < padded.getByteCount()) {
                    ByteBuffer withPadding = ByteBuffer.allocate(padded.getByteCount());
                    withPadding.put(pixels).rewind();
                    pixels = withPadding;
                }
                padded.copyPixelsFromBuffer(pixels);
                visible = Bitmap.createBitmap(padded, crop.left, crop.top, crop.width(), crop.height());
                int[] size = dimensions(visible.getWidth(), visible.getHeight());
                scaled = Bitmap.createScaledBitmap(visible, size[0], size[1], true);
                if (isBlank(scaled)) {
                    blankFrame = true;
                    return "";
                }
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                if (scaled.compress(Bitmap.CompressFormat.JPEG, 85, bytes)) {
                    latest = Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
                }
                return latest == null ? "" : latest;
            } finally {
                if (scaled != visible && scaled != padded) scaled.recycle();
                if (visible != padded) visible.recycle();
                padded.recycle();
            }
        } catch (RuntimeException failed) {
            return "";
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
        return blankFrame ? "blank" : "waiting";
    }

    private synchronized void closeProjection() {
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
        closeProjection();
        super.onDestroy();
    }
}
