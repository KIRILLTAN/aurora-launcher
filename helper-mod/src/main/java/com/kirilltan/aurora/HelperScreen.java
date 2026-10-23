package com.kirilltan.aurora;

import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.text.Text;

import java.util.function.Consumer;
import java.util.function.Supplier;

/** Меню помощника, открывается клавишей F6. */
public class HelperScreen extends Screen {
    private static final int[] RADII = {8, 16, 24, 32, 48, 64};

    public HelperScreen() {
        super(Text.literal("Aurora Helper"));
    }

    @Override
    protected void init() {
        HelperConfig c = HelperConfig.INSTANCE;
        int w = 220;
        int x = this.width / 2 - w / 2;
        int y = this.height / 2 - 100;
        toggle(x, y, w, "Лут на земле", () -> c.loot, v -> c.loot = v);
        addDrawableChild(ButtonWidget.builder(Text.literal("Радиус поиска: " + c.radius + " блоков"), b -> {
            int i = 0;
            while (i < RADII.length && RADII[i] <= c.radius) i++;
            c.radius = RADII[i % RADII.length];
            b.setMessage(Text.literal("Радиус поиска: " + c.radius + " блоков"));
            HelperConfig.save();
        }).dimensions(x, y + 24, w, 20).build());
        toggle(x, y + 48, w / 2 - 2, "Стрелки", () -> c.arrows, v -> c.arrows = v);
        toggle(x + w / 2 + 2, y + 48, w / 2 - 2, "Иконки", () -> c.icons, v -> c.icons = v);
        toggle(x, y + 72, w / 2 - 2, "Координаты", () -> c.coords, v -> c.coords = v);
        toggle(x + w / 2 + 2, y + 72, w / 2 - 2, "FPS", () -> c.fps, v -> c.fps = v);
        toggle(x, y + 96, w / 2 - 2, "Часы", () -> c.clock, v -> c.clock = v);
        toggle(x + w / 2 + 2, y + 96, w / 2 - 2, "Справа", () -> c.rightSide, v -> c.rightSide = v);
        addDrawableChild(ButtonWidget.builder(Text.literal("Строк в списке: " + c.maxLines), b -> {
            c.maxLines = c.maxLines >= 16 ? 4 : c.maxLines + 4;
            b.setMessage(Text.literal("Строк в списке: " + c.maxLines));
            HelperConfig.save();
        }).dimensions(x, y + 120, w, 20).build());
        addDrawableChild(ButtonWidget.builder(Text.literal("Готово"), b -> close()).dimensions(x, y + 152, w, 20).build());
    }

    private void toggle(int x, int y, int w, String label, Supplier<Boolean> get, Consumer<Boolean> set) {
        addDrawableChild(ButtonWidget.builder(label(label, get.get()), b -> {
            set.accept(!get.get());
            b.setMessage(label(label, get.get()));
            HelperConfig.save();
        }).dimensions(x, y, w, 20).build());
    }

    private static Text label(String name, boolean on) {
        return Text.literal(name + ": " + (on ? "§aВКЛ" : "§7выкл"));
    }

    @Override
    public void render(DrawContext ctx, int mouseX, int mouseY, float delta) {
        ctx.fill(0, 0, this.width, this.height, 0x88050816);
        int w = 240;
        int x = this.width / 2 - w / 2;
        int y = this.height / 2 - 130;
        ctx.fill(x, y, x + w, y + 312, 0xE00E1330);
        ctx.fill(x, y, x + w, y + 2, 0xFF38C6FF);
        ctx.drawCenteredTextWithShadow(this.textRenderer, "✦ Aurora Helper ✦", this.width / 2, y + 10, 0xFF38C6FF);
        ctx.drawCenteredTextWithShadow(this.textRenderer, "F6 — открыть/закрыть", this.width / 2, y + 21, 0xFF8B93B8);
        for (var child : this.children()) {
            if (child instanceof net.minecraft.client.gui.Drawable d) d.render(ctx, mouseX, mouseY, delta);
        }
    }

    @Override
    public boolean shouldPause() {
        return false;
    }
}
