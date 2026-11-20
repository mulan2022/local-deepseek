package local.deepseek.chat;

import java.util.Collections;
import java.util.Set;

public class OcrTextGateTest {
    private static void check(boolean pass, String why) { if (!pass) throw new AssertionError(why); }
    private static boolean offer(OcrTextGate gate, String text) { return gate.offer(text, Collections.<String>emptySet(), .6); }
    private static boolean confident(OcrTextGate gate, String text, String line) {
        Set<String> trusted = Collections.singleton(line);
        return gate.offer(text, trusted, .6);
    }
    public static void main(String[] args) {
        check(OcrTextGate.cleanLine("低置信度的中文乱码", 36).isEmpty(), "Reject low confidence");
        check(OcrTextGate.cleanLine("ab@ | /// ^*&", 95).isEmpty(), "Reject symbol noise");
        check(OcrTextGate.cleanLine("AAAAAAAA乱码乱码", 99).isEmpty(), "Reject repeated glyphs");
        check(OcrTextGate.cleanLine("100 22 33 44", 99).isEmpty(), "Counters are not meaningful prose");
        check(OcrTextGate.cleanLine("OK", 99).isEmpty(), "Two Latin letters are too little evidence");
        check(OcrTextGate.cleanLine("这是可以阅读的中文内容。", 90).length() > 0, "Keep reliable Chinese");
        check(OcrTextGate.cleanLine("A readable English subtitle.", 90).length() > 0, "Keep reliable English");
        check(OcrTextGate.cleanLine("这是可以阅读的中文内容。", 68).length() > 0, "Keep moderately confident text");
        check(OcrTextGate.cleanLine("好的！", 90).equals("好的！"), "Keep short dialogue");
        check(OcrTextGate.cleanLine("「你说什么？」", 88).length() > 0, "Chinese punctuation is not symbol noise");
        check(OcrTextGate.cleanLine("等一下……！！！！！", 86).equals("等一下……！！！"), "Collapse repeated punctuation");
        check(OcrTextGate.cleanLine("哈哈哈哈哈哈太好笑了", 90).equals("哈哈哈太好笑了"), "Keep repeated laughter");
        check(OcrTextGate.cleanLine("金币 1280", 92).length() > 0, "Keep labelled numbers");
        String base = "当前任务是在地图上寻找古代遗迹并且解开神秘机关";
        String changed = "旅行者已经到达森林深处发现有人正在等待救援";
        OcrTextGate gate = new OcrTextGate();
        OcrFrameBuffer buffer = new OcrFrameBuffer();
        check(!offer(gate, base) && !offer(gate, base), "Initial stable screen is baseline, never sent");
        for (int i = 0; i < 100; i++) check(!offer(gate, base + " 12:" + (10 + i % 50)), "Clocks never wake AI");
        check(buffer.claim("chat", 9999999, 500, 15000) == null, "Timers alone cannot wake AI");
        check(!offer(gate, base.replace("神秘", "秘密")), "Small text edit is not substantial");
        check(!offer(gate, base.replace("神秘", "秘密")), "Even stable small edits remain quiet");
        check(!offer(gate, changed), "One unstable recognition cannot trigger");
        check(!offer(gate, ""), "Blank frames do not trigger");
        check(!offer(gate, changed) && offer(gate, changed), "Two consistent substantial changes qualify");
        buffer.add(1000, changed, new byte[]{1}); gate.commit();
        check(!offer(gate, changed), "A committed scene cannot duplicate");
        check(buffer.claim("chat", 1100, 500, 15000) == null, "Qualified small batch waits");
        check(buffer.claim("chat", 16000, 500, 15000) != null, "Wait timer only flushes qualified changes");
        gate.reset();
        String staticUi = "游戏设置选项\n任务追踪奖励\n背包物品列表\n朋友在线状态\n";
        offer(gate, staticUi + base); offer(gate, staticUi + base);
        check(!offer(gate, staticUi + changed) && offer(gate, staticUi + changed), "Substantial subtitle change survives static UI");
        gate.commit();
        check(!offer(gate, staticUi + changed + "\n新东西") && !offer(gate, staticUi + changed + "\n新东西"), "Tiny new line never bypasses text threshold");
        gate.reset(); check(!offer(gate, changed) && !offer(gate, changed), "Restart requires new baseline");

        OcrTextGate lines = new OcrTextGate();
        String ui = "设置\n任务\n背包\n主线：前往青石镇寻找铁匠\n金币 1280\n";
        offer(lines, ui); offer(lines, ui);
        check(!offer(lines, "金币 1350\n背包\n主线：前往青石镇寻找铁匠\n设置\n任务"), "Counters and reordered lines are not new");
        check(!offer(lines, ui + "设直") && !offer(lines, ui + "设直"), "A misread character in a short label is not new");
        String subtitle = "前面的桥塌了，我们得绕路过去。";
        check(confident(lines, ui + subtitle, subtitle), "A confident subtitle read once is new");
        lines.commit();
        check(!confident(lines, ui + "好的！", "好的！"), "A confident tiny line still needs a second read");
        check(!offer(lines, ui + "好的！\n走吧。"), "One short line is credited but waits");
        check(offer(lines, ui + "好的！\n走吧。"), "Short lines add up to a change");
        lines.commit();
        check(!offer(lines, ui + "你到哪了") && offer(lines, ui + "你到哪了"), "A short new chat message read twice is enough");
        System.out.println("OCR quality / line text gate tests passed");
    }
}
