package local.deepseek.chat;

import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.LinearLayout;
import android.widget.TextView;

final class FloatingChatWindow {
    private final MainActivity activity;
    private final ChatWebView chat;
    private final WindowManager manager;
    private LinearLayout panel;
    private WindowManager.LayoutParams layout;
    private boolean inputFocused;

    FloatingChatWindow(MainActivity activity, ChatWebView chat) {
        this.activity = activity;
        this.chat = chat;
        manager = activity.getSystemService(WindowManager.class);
    }

    boolean isShowing() { return panel != null; }

    void show() {
        if (panel != null || !Settings.canDrawOverlays(activity)) return;
        LinearLayout window = new LinearLayout(activity) {
            @Override public boolean dispatchTouchEvent(MotionEvent event) {
                if (event.getActionMasked() == MotionEvent.ACTION_OUTSIDE) {
                    focusInput(false);
                    return false;
                }
                return super.dispatchTouchEvent(event);
            }

            @Override public void onWindowFocusChanged(boolean focused) {
                super.onWindowFocusChanged(focused);
                if (focused && inputFocused) {
                    chat.view.requestFocus();
                    activity.getSystemService(InputMethodManager.class).showSoftInput(chat.view, InputMethodManager.SHOW_IMPLICIT);
                }
            }

            @Override public boolean dispatchKeyEvent(android.view.KeyEvent event) {
                if (inputFocused && event.getKeyCode() == android.view.KeyEvent.KEYCODE_BACK) {
                    if (event.getAction() == android.view.KeyEvent.ACTION_UP) focusInput(false);
                    return true;
                }
                return super.dispatchKeyEvent(event);
            }
        };
        window.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(Color.WHITE);
        shape.setCornerRadius(dp(14));
        window.setBackground(shape);
        window.setClipToOutline(true);
        window.setElevation(dp(8));

        LinearLayout bar = new LinearLayout(activity);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(0xffedf1ff);
        TextView handle = label(activity.getString(R.string.floating_chat_title));
        bar.addView(handle, new LinearLayout.LayoutParams(0, dp(36), 1));
        handle.setOnTouchListener(new View.OnTouchListener() {
            private float downX;
            private float downY;
            private int initialX;
            private int initialY;

            @Override public boolean onTouch(View view, MotionEvent event) {
                if (layout == null) return false;
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = event.getRawX();
                        downY = event.getRawY();
                        initialX = layout.x;
                        initialY = layout.y;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        layout.x = initialX + Math.round(event.getRawX() - downX);
                        layout.y = initialY + Math.round(event.getRawY() - downY);
                        place();
                        return true;
                    case MotionEvent.ACTION_UP:
                        view.performClick();
                        return true;
                    default:
                        return true;
                }
            }
        });
        TextView preview = label("▣");
        preview.setTextSize(18);
        preview.setContentDescription(activity.getString(R.string.floating_chat_capture_preview));
        preview.setOnClickListener(view -> {
            focusInput(false);
            chat.view.evaluateJavascript("window.dispatchEvent(new Event('android-capture-preview'))", null);
        });
        bar.addView(preview, new LinearLayout.LayoutParams(dp(36), dp(36)));
        TextView expand = label("↗");
        expand.setTextSize(20);
        expand.setContentDescription(activity.getString(R.string.floating_chat_expand));
        expand.setOnClickListener(view -> activity.returnFromFloatingChat());
        bar.addView(expand, new LinearLayout.LayoutParams(dp(44), dp(36)));
        TextView close = label("×");
        close.setTextSize(20);
        close.setContentDescription(activity.getString(R.string.floating_chat_close));
        close.setOnClickListener(view -> restore());
        bar.addView(close, new LinearLayout.LayoutParams(dp(44), dp(36)));
        window.addView(bar);

        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
            dp(320), dp(260), WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH, PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.LEFT;
        params.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
            | WindowManager.LayoutParams.SOFT_INPUT_STATE_UNSPECIFIED;
        Rect screen = bounds();
        params.width = Math.min(dp(300), Math.max(dp(200), Math.round(screen.width() * 0.72f)));
        params.width = Math.min(params.width, screen.width() - dp(16));
        params.height = Math.min(params.height, screen.height() - dp(20));
        params.x = screen.width() - params.width - dp(8);
        params.y = Math.max(0, screen.height() - params.height - dp(80));
        try {
            manager.addView(window, params);
        } catch (RuntimeException unavailable) {
            chat.notifyFloatingChat("unavailable");
            return;
        }
        panel = window;
        layout = params;
        hideKeyboard();
        detachWebView();
        chat.view.setPadding(0, 0, 0, 0);
        panel.addView(chat.view, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        chat.notifyFloatingChat("open");
        if (!activity.moveTaskToBack(true)) restore();
    }

    void restore() {
        if (panel == null) return;
        remove();
        activity.setContentView(chat.view);
        chat.view.requestApplyInsets();
    }

    void remove() {
        if (panel == null) return;
        hideKeyboard();
        detachWebView();
        if (panel.isAttachedToWindow()) manager.removeViewImmediate(panel);
        panel = null;
        layout = null;
        inputFocused = false;
        chat.notifyFloatingChat("closed");
    }

    void focusInput(boolean focused) {
        if (panel == null || inputFocused == focused) return;
        if (!focused) hideKeyboard();
        inputFocused = focused;
        if (focused) layout.flags &= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        else layout.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        manager.updateViewLayout(panel, layout);
        if (focused) {
            chat.view.requestFocus();
        } else {
            chat.view.evaluateJavascript("document.activeElement?.blur()", null);
        }
    }

    void resize() {
        if (panel == null) return;
        Rect screen = bounds();
        layout.width = Math.min(screen.width() - dp(16),
            Math.min(dp(300), Math.max(dp(200), Math.round(screen.width() * 0.72f))));
        layout.height = Math.min(dp(260), screen.height() - dp(20));
        place();
    }

    private void place() {
        if (!panel.isAttachedToWindow()) return;
        Rect screen = bounds();
        layout.x = Math.max(0, Math.min(layout.x, screen.width() - layout.width));
        layout.y = Math.max(0, Math.min(layout.y, screen.height() - layout.height - dp(48)));
        manager.updateViewLayout(panel, layout);
    }

    private Rect bounds() {
        if (Build.VERSION.SDK_INT >= 30) return manager.getCurrentWindowMetrics().getBounds();
        DisplayMetrics metrics = new DisplayMetrics();
        manager.getDefaultDisplay().getRealMetrics(metrics);
        return new Rect(0, 0, metrics.widthPixels, metrics.heightPixels);
    }

    private TextView label(String text) {
        TextView view = new TextView(activity);
        view.setText(text);
        view.setTextSize(14);
        view.setTextColor(0xff26375b);
        view.setGravity(Gravity.CENTER);
        return view;
    }

    private void detachWebView() {
        if (chat.view.getParent() instanceof ViewGroup) {
            ((ViewGroup) chat.view.getParent()).removeView(chat.view);
        }
    }

    private void hideKeyboard() {
        if (chat.view.getWindowToken() != null) {
            activity.getSystemService(InputMethodManager.class).hideSoftInputFromWindow(chat.view.getWindowToken(), 0);
        }
        chat.view.clearFocus();
    }

    private int dp(int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }
}
