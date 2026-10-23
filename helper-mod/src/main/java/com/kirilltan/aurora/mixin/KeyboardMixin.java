package com.kirilltan.aurora.mixin;

import com.kirilltan.aurora.HelperScreen;
import net.minecraft.client.Keyboard;
import net.minecraft.client.MinecraftClient;
import org.lwjgl.glfw.GLFW;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Клавиша F6 открывает и закрывает меню помощника. */
@Mixin(Keyboard.class)
public class KeyboardMixin {
    @Inject(method = "onKey", at = @At("HEAD"), cancellable = true)
    private void aurora$onKey(long window, int key, int scancode, int action, int modifiers, CallbackInfo ci) {
        if (key != GLFW.GLFW_KEY_F6 || action != GLFW.GLFW_PRESS) return;
        MinecraftClient mc = MinecraftClient.getInstance();
        if (window != mc.getWindow().getHandle() || mc.player == null) return;
        if (mc.currentScreen instanceof HelperScreen) {
            mc.setScreen(null);
            ci.cancel();
        } else if (mc.currentScreen == null) {
            mc.setScreen(new HelperScreen());
            ci.cancel();
        }
    }
}
