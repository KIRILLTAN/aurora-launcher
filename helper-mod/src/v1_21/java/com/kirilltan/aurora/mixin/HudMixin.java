package com.kirilltan.aurora.mixin;

import com.kirilltan.aurora.HelperHud;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.hud.InGameHud;
import net.minecraft.client.render.RenderTickCounter;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Панель помощника поверх интерфейса игры (Minecraft 1.21.x). */
@Mixin(InGameHud.class)
public class HudMixin {
    @Inject(method = "render", at = @At("TAIL"))
    private void aurora$render(DrawContext context, RenderTickCounter tickCounter, CallbackInfo ci) {
        HelperHud.render(context);
    }
}
