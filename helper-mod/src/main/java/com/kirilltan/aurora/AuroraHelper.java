package com.kirilltan.aurora;

import net.fabricmc.api.ClientModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Точка входа помощника Aurora Launcher. */
public class AuroraHelper implements ClientModInitializer {
    public static final Logger LOG = LoggerFactory.getLogger("AuroraHelper");

    @Override
    public void onInitializeClient() {
        HelperConfig.load();
        LOG.info("Aurora Helper loaded — нажмите F6 в игре, чтобы открыть меню");
    }
}
