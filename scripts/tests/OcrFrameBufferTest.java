package local.deepseek.chat;

public class OcrFrameBufferTest {
    private static void check(boolean pass, String message) {
        if (!pass) throw new AssertionError(message);
    }
    private static String text(int length) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < length; i++) out.append('字');
        return out.toString();
    }
    public static void main(String[] args) {
        OcrFrameBuffer buffer = new OcrFrameBuffer();
        buffer.add(1000, text(250), new byte[]{1});
        check(buffer.claim("chat", 1100, 500, 15000) == null, "Do not notify below threshold");
        buffer.add(1200, text(250), new byte[]{2});
        buffer.add(1300, text(250), new byte[]{3});
        OcrFrameBuffer.Batch first = buffer.claim("chat", 1400, 500, 15000);
        check(first != null && first.frames.size() == 2, "500 characters form one batch, leave newer frames queued");
        String id = first.frames.get(0).id;
        check(buffer.image(first.id, id, "other") == null, "Never leak images across conversations");
        check(buffer.image("stale", id, "chat") == null, "Expired batch IDs must fail");
        check(buffer.image(first.id, id, "chat")[0] == 1, "Selected image is available during the round");
        buffer.add(1500, "new", new byte[]{4});
        check(!buffer.complete("wrong"), "Wrong completion cannot clear a live batch");
        check(buffer.complete(first.id), "Round completes");
        check(buffer.image(first.id, id, "chat") == null, "Round images are deleted");
        check(buffer.size() == 2, "Cleanup preserves new samples");
        check(buffer.claim("chat", 1600, 500, 15000) == null, "Small next batch waits");
        OcrFrameBuffer.Batch second = buffer.claim("chat", 17000, 500, 15000);
        check(second != null && second.frames.size() == 2, "Time threshold flushes a small batch");
        buffer.clear();
        for (int i = 0; i < 101; i++) buffer.add(i, "", new byte[]{(byte)i});
        check(buffer.size() == 100, "Ring never exceeds 100 images");
        OcrFrameBuffer.Batch full = buffer.claim("chat", 20000, 500, 15000);
        check(full.frames.get(0).jpeg[0] == 1, "Oldest unclaimed image is evicted");
        check(!buffer.add(30000, "", new byte[]{0}), "Full pinned batch cannot be evicted");
        buffer.complete(full.id);
        check(buffer.size() == 0 && buffer.bytes() == 0, "All pinned memory is released");
        byte[] large = new byte[33 * 1024 * 1024];
        buffer.add(0, "x", large);
        OcrFrameBuffer.Batch pinned = buffer.claim("chat", 20000, 500, 15000);
        check(!buffer.add(30000, "x", large), "64 MB limit includes pinned images");
        check(buffer.bytes() == large.length, "Failed add does not corrupt byte accounting");
        buffer.complete(pinned.id);
        check(buffer.bytes() == 0, "Byte accounting returns to zero");
        check(OcrFrameBuffer.normalize("字幕 12:34").equals(OcrFrameBuffer.normalize("字幕 12:35")), "Clock changes are ignored");
        check(OcrFrameBuffer.difference("旧字幕", "全新的对话") > 0.3, "Substantial text changes are detected");
        check(OcrFrameBuffer.changedLine("视频标题与固定界面文字\n今天想去哪里玩", "视频标题与固定界面文字\n下雨记得带伞回家", 0.3),
            "A changed subtitle is detected even when the rest of the UI stays the same");
        check(!OcrFrameBuffer.changedLine("现在时间 12:34\n固定界面文字", "现在时间 12:35\n固定界面文字", 0.3),
            "Clock changes alone do not create a subtitle event");
        System.out.println("PASS OCR batching, 500-char behavior, time flush, 100-image and 64-MB bounds, pinning, session isolation and cleanup");
    }
}
