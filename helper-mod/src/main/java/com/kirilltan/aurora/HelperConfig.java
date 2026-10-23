package com.kirilltan.aurora;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.fabricmc.loader.api.FabricLoader;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Настройки помощника, хранятся в config/aurora-helper.json. */
public class HelperConfig {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static Path file() {
        return FabricLoader.getInstance().getConfigDir().resolve("aurora-helper.json");
    }

    public static HelperConfig INSTANCE = new HelperConfig();

    /** Список лута на земле */
    public boolean loot = true;
    /** Радиус поиска лута в блоках */
    public int radius = 16;
    /** Стрелки-направления к предметам */
    public boolean arrows = true;
    /** Иконки предметов в списке */
    public boolean icons = true;
    /** Максимум строк в списке */
    public int maxLines = 8;
    /** Координаты и направление взгляда */
    public boolean coords = false;
    /** Счётчик FPS */
    public boolean fps = false;
    /** Счётчик игрового времени (часы в игре) */
    public boolean clock = false;
    /** Панель справа вместо слева */
    public boolean rightSide = false;

    public static void load() {
        try {
            Path f = file();
            if (Files.exists(f)) {
                HelperConfig c = GSON.fromJson(Files.readString(f, StandardCharsets.UTF_8), HelperConfig.class);
                if (c != null) INSTANCE = c;
            }
        } catch (Exception e) {
            AuroraHelper.LOG.warn("Не удалось прочитать настройки Aurora Helper", e);
        }
    }

    public static void save() {
        try {
            Files.writeString(file(), GSON.toJson(INSTANCE), StandardCharsets.UTF_8);
        } catch (Exception e) {
            AuroraHelper.LOG.warn("Не удалось сохранить настройки Aurora Helper", e);
        }
    }
}
