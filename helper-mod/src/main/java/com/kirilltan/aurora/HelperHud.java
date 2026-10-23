package com.kirilltan.aurora;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.font.TextRenderer;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.ItemEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.util.math.MathHelper;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Отрисовка панели помощника поверх игры. */
public final class HelperHud {
    private static final String[] ARROWS = {"↑", "↗", "→", "↘", "↓", "↙", "←", "↖"};
    private static final int PANEL_BG = 0x90101428;
    private static final int ACCENT = 0xFF38C6FF;

    private HelperHud() {}

    private record Group(ItemStack stack, String name, int count, double distance, String arrow, boolean glint) {}

    public static void render(DrawContext ctx) {
        MinecraftClient mc = MinecraftClient.getInstance();
        HelperConfig cfg = HelperConfig.INSTANCE;
        ClientPlayerEntity player = mc.player;
        if (player == null || mc.world == null || mc.options.hudHidden) return;
        if (mc.currentScreen instanceof HelperScreen) return;
        TextRenderer font = mc.textRenderer;

        List<String> info = new ArrayList<>();
        if (cfg.coords) {
            info.add(String.format("XYZ: %d %d %d  %s", player.getBlockX(), player.getBlockY(), player.getBlockZ(),
                    facing(player.getYaw())));
        }
        if (cfg.fps) info.add(mc.getCurrentFps() + " FPS");
        if (cfg.clock) {
            long t = (mc.world.getTimeOfDay() + 6000) % 24000;
            info.add(String.format("Время: %02d:%02d  День %d", t / 1000, (t % 1000) * 60 / 1000, mc.world.getTimeOfDay() / 24000 + 1));
        }

        List<Group> groups = cfg.loot ? collectLoot(player, cfg) : List.of();
        if (info.isEmpty() && !cfg.loot) return;

        int lineH = cfg.icons ? 18 : 11;
        int width = 0;
        for (String s : info) width = Math.max(width, font.getWidth(s));
        String title = "Лут рядом: " + groups.size();
        if (cfg.loot) width = Math.max(width, font.getWidth(title));
        List<String> rows = new ArrayList<>();
        for (Group g : groups) {
            String row = g.name + (g.count > 1 ? " ×" + g.count : "") + "  " + Math.round(g.distance) + "м" + (cfg.arrows ? " " + g.arrow : "");
            rows.add(row);
            width = Math.max(width, font.getWidth(row) + (cfg.icons ? 20 : 0));
        }
        int height = info.size() * 11 + (cfg.loot ? 13 + Math.max(1, rows.size()) * lineH : 0);
        int pad = 5;
        int x = cfg.rightSide ? ctx.getScaledWindowWidth() - width - pad * 2 - 4 : 4;
        int y = 4;
        ctx.fill(x, y, x + width + pad * 2, y + height + pad * 2 - 2, PANEL_BG);
        ctx.fill(x, y, x + 2, y + height + pad * 2 - 2, ACCENT);
        int cy = y + pad;
        for (String s : info) {
            ctx.drawTextWithShadow(font, s, x + pad, cy, 0xFFE8ECFF);
            cy += 11;
        }
        if (!cfg.loot) return;
        ctx.drawTextWithShadow(font, title, x + pad, cy, ACCENT);
        cy += 13;
        if (rows.isEmpty()) {
            ctx.drawTextWithShadow(font, "ничего в радиусе " + cfg.radius + " бл.", x + pad, cy, 0xFF8B93B8);
            return;
        }
        for (int i = 0; i < rows.size(); i++) {
            Group g = groups.get(i);
            int tx = x + pad;
            if (cfg.icons) {
                ctx.drawItem(g.stack, tx, cy);
                tx += 20;
            }
            int color = g.glint ? 0xFFFFD86B : 0xFFFFFFFF;
            ctx.drawTextWithShadow(font, rows.get(i), tx, cy + (cfg.icons ? 4 : 0), color);
            cy += lineH;
        }
    }

    private static List<Group> collectLoot(ClientPlayerEntity player, HelperConfig cfg) {
        List<ItemEntity> items = player.getWorld().getEntitiesByClass(ItemEntity.class,
                player.getBoundingBox().expand(cfg.radius), e -> e.isAlive() && !e.getStack().isEmpty());
        items.sort((a, b) -> Double.compare(player.squaredDistanceTo(a), player.squaredDistanceTo(b)));
        Map<String, Group> grouped = new LinkedHashMap<>();
        for (ItemEntity e : items) {
            ItemStack st = e.getStack();
            String name = st.getName().getString();
            Group prev = grouped.get(name);
            if (prev != null) {
                grouped.put(name, new Group(prev.stack, name, prev.count + st.getCount(), prev.distance, prev.arrow, prev.glint));
                continue;
            }
            double dx = e.getX() - player.getX();
            double dz = e.getZ() - player.getZ();
            float target = (float) Math.toDegrees(Math.atan2(-dx, dz));
            float rel = MathHelper.wrapDegrees(target - player.getYaw());
            int idx = Math.floorMod(Math.round(rel / 45f), 8);
            grouped.put(name, new Group(st, name, st.getCount(), player.distanceTo(e), ARROWS[idx], st.hasGlint()));
        }
        List<Group> out = new ArrayList<>(grouped.values());
        return out.size() > cfg.maxLines ? out.subList(0, cfg.maxLines) : out;
    }

    private static String facing(float yaw) {
        String[] dirs = {"Юг", "Юго-запад", "Запад", "Северо-запад", "Север", "Северо-восток", "Восток", "Юго-восток"};
        return dirs[Math.floorMod(Math.round(MathHelper.wrapDegrees(yaw) / 45f), 8)];
    }
}
