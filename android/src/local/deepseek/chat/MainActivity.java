package local.deepseek.chat;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.Toast;
import android.view.WindowInsets;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

public final class MainActivity extends Activity {
    private static final String AUDIO = PermissionRequest.RESOURCE_AUDIO_CAPTURE;
    private static final int PICK_FILE = 1;
    private static final int REQUEST_MICROPHONE = 2;
    private static final int SAVE_FILE = 3;
    private static final int OVERLAY_PERMISSION = 4;

    final LocalFiles localFiles = new LocalFiles();
    private ChatWebView chat;
    private FloatingChatWindow floatingChat;
    private boolean openAfterPermission;
    private ValueCallback<Uri[]> fileChooser;
    private PermissionRequest microphone;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        chat = ChatWebView.get(this);
        chat.attach(this);
        floatingChat = new FloatingChatWindow(this, chat);
        WebView webView = chat.view;
        webView.setWebChromeClient(new AndroidDialogs());
        if (Build.VERSION.SDK_INT >= 30) {
            webView.setOnApplyWindowInsetsListener((view, windowInsets) -> {
                if (floatingChat.isShowing()) return windowInsets;
                Insets insets = windowInsets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()
                    | WindowInsets.Type.ime());
                view.setPadding(insets.left, insets.top, insets.right, insets.bottom);
                return windowInsets;
            });
        }
        setContentView(webView);
    }

    @Override
    protected void onResume() {
        super.onResume();
        chat.phoneTools.setResumed(this, true);
        floatingChat.restore();
        HeartbeatJob.resumeLocalSchedule(this);
        if (openAfterPermission) {
            openAfterPermission = false;
            getWindow().getDecorView().post(this::openFloatingChat);
        }
    }

    @Override
    protected void onPause() {
        chat.phoneTools.setResumed(this, false);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        floatingChat.remove();
        chat.detach(this);
        super.onDestroy();
    }

    void openFloatingChat() {
        if (isFinishing() || isDestroyed()) return;
        if (Settings.canDrawOverlays(this)) {
            floatingChat.show();
            return;
        }
        try {
            startActivityForResult(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + getPackageName())), OVERLAY_PERMISSION);
        } catch (ActivityNotFoundException unavailable) {
            chat.notifyFloatingChat("unavailable");
        }
    }

    void returnFromFloatingChat() {
        try {
            startActivity(new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP));
        } catch (RuntimeException unavailable) {
            chat.notifyFloatingChat("unavailable");
        }
    }

    void focusFloatingInput(boolean focused) {
        floatingChat.focusInput(focused);
    }

    @Override public void onConfigurationChanged(android.content.res.Configuration config) {
        super.onConfigurationChanged(config);
        floatingChat.resize();
    }

    private final class AndroidDialogs extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                FileChooserParams params) {
            if (fileChooser != null) fileChooser.onReceiveValue(null);
            fileChooser = callback;
            try {
                startActivityForResult(params.createIntent(), PICK_FILE);
            } catch (ActivityNotFoundException error) {
                fileChooser = null;
                callback.onReceiveValue(null);
            }
            return true;
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            boolean requestsAudio = false;
            for (String resource : request.getResources()) {
                requestsAudio |= AUDIO.equals(resource);
            }
            if (!ChatWebView.isLocal(request.getOrigin()) || !requestsAudio) {
                request.deny();
            } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[] { AUDIO });
            } else if (microphone == null) {
                microphone = request;
                requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_MICROPHONE);
            } else {
                request.deny();
            }
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (microphone == request) microphone = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == REQUEST_MICROPHONE && microphone != null) {
            PermissionRequest request = microphone;
            microphone = null;
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[] { AUDIO });
            } else {
                request.deny();
            }
        }
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        chat.phoneTools.onActivityResult(code, result, data);
        if (code == OVERLAY_PERMISSION) {
            if (Settings.canDrawOverlays(this)) openAfterPermission = true;
            else chat.notifyFloatingChat("denied");
        }
        if (code == PICK_FILE && fileChooser != null) {
            ValueCallback<Uri[]> callback = fileChooser;
            fileChooser = null;
            callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        }
        if (code == SAVE_FILE) {
            localFiles.writeTo(result == RESULT_OK && data != null ? data.getData() : null);
        }
    }

    public final class LocalFiles {
        private File pending;
        private boolean saving;

        @JavascriptInterface
        public synchronized boolean begin() {
            if (saving || pending != null) return false;
            try {
                pending = File.createTempFile("export-", ".tmp", getCacheDir());
                return true;
            } catch (IOException error) {
                return false;
            }
        }

        @JavascriptInterface
        public synchronized boolean append(String chunk) {
            if (pending == null || saving) return false;
            try (OutputStream out = new FileOutputStream(pending, true)) {
                out.write(Base64.decode(chunk, Base64.DEFAULT));
                return true;
            } catch (IOException | IllegalArgumentException error) {
                return false;
            }
        }

        @JavascriptInterface
        public synchronized boolean chooseDestination(String name, String type) {
            if (pending == null || saving) return false;
            saving = true;
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(type)
                    .putExtra(Intent.EXTRA_TITLE, name);
                try {
                    startActivityForResult(intent, SAVE_FILE);
                } catch (ActivityNotFoundException error) {
                    reset();
                    Toast.makeText(MainActivity.this, "无法打开保存窗口", Toast.LENGTH_SHORT).show();
                }
            });
            return true;
        }

        @JavascriptInterface
        public synchronized void cancel() {
            if (!saving) reset();
        }

        private synchronized void reset() {
            if (pending != null) pending.delete();
            pending = null;
            saving = false;
        }

        private synchronized void writeTo(Uri destination) {
            if (destination == null || pending == null) {
                reset();
                return;
            }
            File source = pending;
            new Thread(() -> {
                boolean success = false;
                try (InputStream in = new java.io.FileInputStream(source);
                        OutputStream out = getContentResolver().openOutputStream(destination, "w")) {
                    if (out == null) throw new IOException("Cannot open destination");
                    byte[] buffer = new byte[64 * 1024];
                    int length;
                    while ((length = in.read(buffer)) != -1) out.write(buffer, 0, length);
                    out.flush();
                    success = true;
                } catch (IOException | SecurityException ignored) {
                    // A storage provider can revoke access while writing.
                } finally {
                    reset();
                }
                String message = success ? "文件已保存" : "文件保存失败";
                runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show());
            }, "local-file-export").start();
        }
    }
}
