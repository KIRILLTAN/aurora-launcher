package com.kirilltan.aurora.agent;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.AccessibleObject;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Aurora Overlay — Java-агент (не мод). Работает с любой версией и загрузчиком:
 * через рефлексию читает позицию камеры, лут на земле, броню и предмет в левой руке
 * и отправляет это лаунчеру, который рисует прозрачный оверлей поверх окна игры.
 * Имена классов и методов для конкретной версии лаунчер подготавливает заранее
 * (файл маппингов), поэтому агенту не нужны зависимости от Minecraft.
 */
public final class Agent {
    private static Instrumentation inst;
    private static final Map<String, String> CLS = new HashMap<>();
    private static final Map<String, String> MEM = new HashMap<>();
    private static final Map<String, Class<?>> classCache = new HashMap<>();
    private static final Map<String, Object> memberCache = new HashMap<>();
    private static final Set<String> missing = new HashSet<>();
    private static final Object NONE = new Object();

    public static void premain(String args, Instrumentation instrumentation) {
        inst = instrumentation;
        Thread t = new Thread(() -> {
            try {
                run(args == null ? "" : args);
            } catch (Throwable e) {
                System.err.println("[AuroraOverlay] " + e);
            }
        }, "Aurora-Overlay");
        t.setDaemon(true);
        t.start();
    }

    // ---------------- Маппинги ----------------

    private static void loadMappings(String file) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(new File(file)), StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) sb.append(line).append('\n');
        }
        // простой формат: "C\tключ\tимя" и "M\tключ\tимя"
        for (String line : sb.toString().split("\n")) {
            String[] p = line.split("\t");
            if (p.length < 3) continue;
            if (p[0].equals("C")) CLS.put(p[1], p[2]);
            else MEM.put(p[1], p[2]);
        }
    }

    private static Class<?> cls(String moj) {
        Class<?> c = classCache.get(moj);
        if (c != null) return c;
        String name = CLS.getOrDefault(moj, moj);
        try {
            c = Class.forName(name, false, ClassLoader.getSystemClassLoader());
        } catch (Throwable ignored) {
            for (Class<?> k : inst.getAllLoadedClasses()) {
                if (k.getName().equals(name)) {
                    c = k;
                    break;
                }
            }
        }
        if (c != null) {
            open(c);
            classCache.put(moj, c);
        }
        return c;
    }

    /** На Forge/NeoForge классы игры лежат в модулях — открываем их агенту. */
    private static final Set<Object> opened = new HashSet<>();

    private static void open(Class<?> c) {
        try {
            Method getModule = Class.class.getMethod("getModule");
            Object module = getModule.invoke(c);
            if (module == null || opened.contains(module)) return;
            opened.add(module);
            Object me = getModule.invoke(Agent.class);
            Class<?> modCls = Class.forName("java.lang.Module");
            Set<?> pkgs = (Set<?>) modCls.getMethod("getPackages").invoke(module);
            Map<String, Set<Object>> opens = new HashMap<>();
            for (Object p : pkgs) opens.put((String) p, Collections.singleton(me));
            Method redefine = Instrumentation.class.getMethod("redefineModule", modCls, Set.class, Map.class, Map.class, Set.class, Map.class);
            redefine.invoke(inst, module, Collections.emptySet(), opens, opens, Collections.emptySet(), Collections.emptyMap());
        } catch (Throwable ignored) {
            // Java 8 или модуль уже открыт
        }
    }

    private static void access(AccessibleObject o) {
        try {
            o.setAccessible(true);
        } catch (Throwable ignored) {
        }
    }

    private static Method method(String moj, String name, int argc) {
        String key = "M:" + moj + "#" + name + "#" + argc;
        Object cached = memberCache.get(key);
        if (cached != null) return cached == NONE ? null : (Method) cached;
        Method found = null;
        Class<?> c = cls(moj);
        String runtime = MEM.getOrDefault(moj + "#" + name + "#" + argc, name);
        if (c != null) found = findMethod(c, runtime, argc, new HashSet<Class<?>>());
        if (found != null) access(found);
        else missing.add(moj + "." + name);
        memberCache.put(key, found == null ? NONE : found);
        return found;
    }

    private static Method findMethod(Class<?> c, String name, int argc, Set<Class<?>> seen) {
        if (c == null || !seen.add(c)) return null;
        for (Method m : c.getDeclaredMethods()) {
            if (m.getName().equals(name) && m.getParameterCount() == argc) return m;
        }
        Method m = findMethod(c.getSuperclass(), name, argc, seen);
        if (m != null) return m;
        for (Class<?> i : c.getInterfaces()) {
            m = findMethod(i, name, argc, seen);
            if (m != null) return m;
        }
        return null;
    }

    private static Field field(String moj, String name) {
        String key = "F:" + moj + "#" + name;
        Object cached = memberCache.get(key);
        if (cached != null) return cached == NONE ? null : (Field) cached;
        Field found = null;
        String runtime = MEM.getOrDefault(moj + "#" + name, name);
        for (Class<?> c = cls(moj); c != null && found == null; c = c.getSuperclass()) {
            try {
                found = c.getDeclaredField(runtime);
            } catch (NoSuchFieldException ignored) {
            }
        }
        if (found != null) access(found);
        else missing.add(moj + "." + name);
        memberCache.put(key, found == null ? NONE : found);
        return found;
    }

    private static Object call(Object target, String moj, String name, Object... args) {
        Method m = method(moj, name, args.length);
        if (m == null) return null;
        try {
            return m.invoke(Modifier.isStatic(m.getModifiers()) ? null : target, args);
        } catch (Throwable e) {
            return null;
        }
    }

    private static Object get(Object target, String moj, String name) {
        Field f = field(moj, name);
        if (f == null) return null;
        try {
            return f.get(Modifier.isStatic(f.getModifiers()) ? null : target);
        } catch (Throwable e) {
            return null;
        }
    }

    /** Первый найденный метод из вариантов имени (имена меняются между версиями игры). */
    private static Object callAny(Object target, String moj, String[] names, Object... args) {
        for (String n : names) {
            if (methodQuiet(moj, n, args.length) != null) return call(target, moj, n, args);
        }
        return null;
    }

    private static Method methodQuiet(String moj, String name, int argc) {
        boolean had = missing.contains(moj + "." + name);
        Method m = method(moj, name, argc);
        if (m == null && !had) missing.remove(moj + "." + name);
        return m;
    }

    private static Field fieldQuiet(String moj, String name) {
        boolean had = missing.contains(moj + "." + name);
        Field f = field(moj, name);
        if (f == null && !had) missing.remove(moj + "." + name);
        return f;
    }

    private static Object screenOf(Object mc) {
        if (fieldQuiet(MC, "screen") != null) return get(mc, MC, "screen");
        // 26.x: экран переехал в Gui
        Object gui = get(mc, MC, "gui");
        if (gui == null) return null;
        if (methodQuiet(GUI, "screen", 0) != null) return call(gui, GUI, "screen");
        return get(gui, GUI, "screen");
    }

    private static Object cameraOf(Object mc) {
        Object gr = get(mc, MC, "gameRenderer");
        return gr == null ? null : callAny(gr, GAME_RENDERER, new String[]{"getMainCamera", "mainCamera"});
    }

    private static double num(Object o) {
        return o instanceof Number ? ((Number) o).doubleValue() : Double.NaN;
    }

    // ---------------- Имена классов (Mojang) ----------------

    private static final String MC = "net.minecraft.client.Minecraft";
    private static final String ENTITY = "net.minecraft.world.entity.Entity";
    private static final String LIVING = "net.minecraft.world.entity.LivingEntity";
    private static final String ITEM_ENTITY = "net.minecraft.world.entity.item.ItemEntity";
    private static final String STACK = "net.minecraft.world.item.ItemStack";
    private static final String TEXT = "net.minecraft.network.chat.FormattedText";
    private static final String COMPONENT = "net.minecraft.network.chat.Component";
    private static final String CLEVEL = "net.minecraft.client.multiplayer.ClientLevel";
    private static final String LEVEL = "net.minecraft.world.level.Level";
    private static final String GAME_RENDERER = "net.minecraft.client.renderer.GameRenderer";
    private static final String CAMERA = "net.minecraft.client.Camera";
    private static final String VEC3 = "net.minecraft.world.phys.Vec3";
    private static final String OPTIONS = "net.minecraft.client.Options";
    private static final String OPTION_INSTANCE = "net.minecraft.client.OptionInstance";
    private static final String WINDOW = "com.mojang.blaze3d.platform.Window";
    private static final String SLOT = "net.minecraft.world.entity.EquipmentSlot";
    private static final String GUI = "net.minecraft.client.gui.Gui";
    private static final String ITEM = "net.minecraft.world.item.Item";

    // ---------------- Главный цикл ----------------

    private static void run(String args) throws Exception {
        String[] a = args.split("\\|");
        int port = Integer.parseInt(a[0]);
        String token = a.length > 1 ? a[1] : "";
        // путь к маппингам приходит в base64: Java на Windows портит не-ASCII символы в аргументах агента
        String mapError = null;
        if (a.length > 2 && !a[2].isEmpty()) {
            String mapFile = a[2].startsWith("b64:")
                    ? new String(java.util.Base64.getUrlDecoder().decode(a[2].substring(4)), StandardCharsets.UTF_8)
                    : a[2];
            try {
                loadMappings(mapFile);
            } catch (Throwable e) {
                mapError = String.valueOf(e);
                System.err.println("[AuroraOverlay] маппинги: " + e);
            }
        }
        boolean borderlessWanted = a.length > 3 && a[3].contains("b") && !System.getProperty("os.name", "").toLowerCase().contains("mac");

        // ждём, пока игра загрузится
        Object mc = null;
        while (mc == null) {
            Thread.sleep(1000);
            if (cls(MC) == null) continue;
            memberCache.clear();
            missing.clear();
            mc = call(null, MC, "getInstance");
        }
        final Object game = mc;
        Socket socket = new Socket("127.0.0.1", port);
        socket.setTcpNoDelay(true);
        OutputStream out = socket.getOutputStream();
        // заранее находим всё, чтобы лаунчер знал, чего не хватает
        warmup();
        send(out, "{\"t\":\"hello\",\"token\":" + str(token) + ",\"missing\":" + strList(new ArrayList<>(missing))
                + (mapError != null ? ",\"error\":" + str("маппинги: " + mapError) : "") + "}");

        final AtomicReference<String> latest = new AtomicReference<>();
        final AtomicBoolean pending = new AtomicBoolean(false);
        Executor executor = game instanceof Executor ? (Executor) game : null;
        long tick = 0;
        while (true) {
            long started = System.nanoTime();
            // раз в ~250 мс: полноэкранный режим → окно без рамки (поверх эксклюзивного режима оверлей не виден)
            if (borderlessWanted && executor != null && tick++ % 15 == 0) {
                executor.execute(() -> {
                    try {
                        Fullscreen.check(game);
                    } catch (Throwable e) {
                        Fullscreen.status = "ошибка: " + e;
                        System.err.println("[AuroraOverlay] borderless: " + e);
                    }
                });
            }
            if (executor != null) {
                if (pending.compareAndSet(false, true)) {
                    executor.execute(() -> {
                        try {
                            latest.set(snapshot(game));
                        } catch (Throwable e) {
                            latest.set(null);
                        } finally {
                            pending.set(false);
                        }
                    });
                }
            } else {
                latest.set(snapshot(game));
            }
            String s = latest.getAndSet(null);
            if (s != null) send(out, s);
            long sleep = 16 - (System.nanoTime() - started) / 1_000_000;
            if (sleep > 0) Thread.sleep(sleep);
        }
    }

    private static void warmup() {
        method(MC, "getInstance", 0);
        field(MC, "player");
        field(MC, "level");
        field(MC, "options");
        field(MC, "gameRenderer");
        method(MC, "getWindow", 0);
        method(MC, "isWindowActive", 0);
        method(ENTITY, "getX", 0);
        method(ENTITY, "getY", 0);
        method(ENTITY, "getZ", 0);
        method(LIVING, "getItemBySlot", 1);
        method(LIVING, "getOffhandItem", 0);
        method(ITEM_ENTITY, "getItem", 0);
        method(STACK, "getCount", 0);
        method(STACK, "getHoverName", 0);
        method(CLEVEL, "entitiesForRendering", 0);
        method(WINDOW, "getScreenWidth", 0);
        method(WINDOW, "getScreenHeight", 0);
        // члены с разными именами в разных версиях: ошибка, только если нет ни одного варианта
        if (fieldQuiet(MC, "screen") == null && fieldQuiet(MC, "gui") == null) missing.add(MC + ".screen");
        if (methodQuiet(STACK, "getDescriptionId", 0) == null && methodQuiet(ITEM, "getDescriptionId", 0) == null) missing.add(STACK + ".getDescriptionId");
        if (methodQuiet(GAME_RENDERER, "getMainCamera", 0) == null && methodQuiet(GAME_RENDERER, "mainCamera", 0) == null) missing.add(GAME_RENDERER + ".getMainCamera");
        if (methodQuiet(CAMERA, "getYRot", 0) == null && methodQuiet(CAMERA, "yRot", 0) == null) missing.add(CAMERA + ".getYRot");
        if (methodQuiet(CAMERA, "getXRot", 0) == null && methodQuiet(CAMERA, "xRot", 0) == null) missing.add(CAMERA + ".getXRot");
        // необязательные — разные версии игры, пропускаем в отчёте
        Set<String> optional = new HashSet<>();
        for (String s : missing) optional.add(s);
        missing.clear();
        for (String s : optional) {
            if (!s.endsWith("getFps") && !s.endsWith(".fps")) missing.add(s);
        }
    }

    private static Object slot(String name) {
        return get(null, SLOT, name);
    }

    private static String snapshot(Object mc) {
        StringBuilder sb = new StringBuilder(4096);
        sb.append("{\"t\":\"s\"");
        Object window = call(mc, MC, "getWindow");
        if (window != null) {
            sb.append(",\"win\":[").append(fmt(num(call(window, WINDOW, "getX")))).append(',')
                    .append(fmt(num(call(window, WINDOW, "getY")))).append(',')
                    .append(fmt(num(call(window, WINDOW, "getScreenWidth")))).append(',')
                    .append(fmt(num(call(window, WINDOW, "getScreenHeight")))).append(',')
                    .append(fmt(num(call(window, WINDOW, "getGuiScale")))).append(']');
        }
        if (Fullscreen.status != null) sb.append(",\"bl\":").append(str(Fullscreen.status));
        Object active = call(mc, MC, "isWindowActive");
        sb.append(",\"active\":").append(!Boolean.FALSE.equals(active));
        sb.append(",\"screen\":").append(screenOf(mc) != null);
        Object fps = call(mc, MC, "getFps");
        if (fps == null) fps = get(null, MC, "fps");
        if (fps != null) sb.append(",\"fps\":").append(fmt(num(fps)));

        Object player = get(mc, MC, "player");
        Object level = get(mc, MC, "level");
        if (player == null || level == null) return sb.append(",\"inGame\":false}").toString();
        sb.append(",\"inGame\":true");

        double px = num(call(player, ENTITY, "getX"));
        double py = num(call(player, ENTITY, "getY"));
        double pz = num(call(player, ENTITY, "getZ"));
        Object yaw = call(player, ENTITY, "getYRot");
        if (yaw == null) yaw = get(player, ENTITY, "yRot");
        sb.append(",\"pos\":[").append(fmt(px)).append(',').append(fmt(py)).append(',').append(fmt(pz)).append(',').append(fmt(num(yaw))).append(']');
        Object time = call(level, LEVEL, "getDayTime");
        if (time != null) sb.append(",\"time\":").append(fmt(num(time)));

        // камера (интерполированная — та же, что видит игрок)
        Object cam = cameraOf(mc);
        if (cam != null) {
            Object pos = callAny(cam, CAMERA, new String[]{"getPosition", "position"});
            if (pos != null) {
                sb.append(",\"cam\":[").append(fmt(num(get(pos, VEC3, "x")))).append(',').append(fmt(num(get(pos, VEC3, "y")))).append(',')
                        .append(fmt(num(get(pos, VEC3, "z")))).append(',').append(fmt(num(callAny(cam, CAMERA, new String[]{"getYRot", "yRot"})))).append(',')
                        .append(fmt(num(callAny(cam, CAMERA, new String[]{"getXRot", "xRot"})))).append(']');
            }
        }
        Object options = get(mc, MC, "options");
        if (options != null) {
            if (Boolean.TRUE.equals(get(options, OPTIONS, "hideGui"))) sb.append(",\"hideGui\":true");
            Object fov = call(options, OPTIONS, "fov");
            if (fov != null) fov = call(fov, OPTION_INSTANCE, "get");
            else fov = get(options, OPTIONS, "fov");
            if (fov != null) sb.append(",\"fov\":").append(fmt(num(fov)));
        }

        // броня и левая рука
        sb.append(",\"armor\":[");
        String[] slots = {"HEAD", "CHEST", "LEGS", "FEET"};
        boolean first = true;
        for (String s : slots) {
            Object sl = slot(s);
            Object st = sl == null ? null : call(player, LIVING, "getItemBySlot", sl);
            if (!first) sb.append(',');
            first = false;
            stack(sb, st);
        }
        sb.append("],\"off\":");
        stack(sb, call(player, LIVING, "getOffhandItem"));

        // лут на земле: до 64 ближайших в радиусе 64 блоков
        sb.append(",\"loot\":[");
        Object ents = call(level, CLEVEL, "entitiesForRendering");
        Class<?> itemCls = cls(ITEM_ENTITY);
        if (ents instanceof Iterable && itemCls != null) {
            List<double[]> found = new ArrayList<>();
            List<Object> stacks = new ArrayList<>();
            try {
                for (Object e : (Iterable<?>) ents) {
                    if (!itemCls.isInstance(e)) continue;
                    double x = num(call(e, ENTITY, "getX")), y = num(call(e, ENTITY, "getY")), z = num(call(e, ENTITY, "getZ"));
                    double d = (x - px) * (x - px) + (y - py) * (y - py) + (z - pz) * (z - pz);
                    if (d > 64 * 64) continue;
                    found.add(new double[]{x, y, z, d, stacks.size()});
                    stacks.add(call(e, ITEM_ENTITY, "getItem"));
                }
            } catch (Throwable ignored) {
                // список сущностей изменился во время обхода — пропускаем кадр
            }
            found.sort((p, q) -> Double.compare(p[3], q[3]));
            for (int i = 0; i < found.size() && i < 64; i++) {
                double[] f = found.get(i);
                if (i > 0) sb.append(',');
                sb.append("{\"p\":[").append(fmt(f[0])).append(',').append(fmt(f[1])).append(',').append(fmt(f[2])).append("],\"i\":");
                stack(sb, stacks.get((int) f[4]));
                sb.append('}');
            }
        }
        sb.append("]}");
        return sb.toString();
    }

    private static void stack(StringBuilder sb, Object st) {
        if (st == null || Boolean.TRUE.equals(call(st, STACK, "isEmpty"))) {
            sb.append("null");
            return;
        }
        Object name = call(st, STACK, "getHoverName");
        Object text = name == null ? null : call(name, TEXT, "getString");
        if (text == null && name != null) text = call(name, COMPONENT, "getString");
        Object id = methodQuiet(STACK, "getDescriptionId", 0) != null ? call(st, STACK, "getDescriptionId") : null;
        if (id == null) {
            // в новых версиях id есть только у самого предмета: "item.minecraft.diamond"
            Object item = call(st, STACK, "getItem");
            if (item != null) id = methodQuiet(ITEM, "getDescriptionId", 0) != null ? call(item, ITEM, "getDescriptionId") : null;
            if (id == null && item != null) id = String.valueOf(item);
        }
        sb.append("{\"id\":").append(str(String.valueOf(id)))
                .append(",\"n\":").append(str(text == null ? "?" : String.valueOf(text)))
                .append(",\"c\":").append(fmt(num(call(st, STACK, "getCount"))));
        if (Boolean.TRUE.equals(call(st, STACK, "isDamageableItem"))) {
            sb.append(",\"d\":").append(fmt(num(call(st, STACK, "getDamageValue"))))
                    .append(",\"md\":").append(fmt(num(call(st, STACK, "getMaxDamage"))));
        }
        if (Boolean.TRUE.equals(call(st, STACK, "hasFoil"))) sb.append(",\"g\":1");
        sb.append('}');
    }

    // ---------------- Полный экран без рамки ----------------

    /**
     * Эксклюзивный полноэкранный режим перекрывает все окна, поэтому оверлей в нём не виден.
     * Переводим игру в окно без рамки на весь монитор: выглядит так же, а оверлей виден.
     * F11 и настройка «Полный экран» продолжают работать: выход возвращает обычное окно.
     */
    static final class Fullscreen {
        private static final int GLFW_DECORATED = 0x00020005;
        private static boolean borderless;
        private static boolean exiting;
        private static long[] pending; // {monitor} — ждём, пока игра выйдет из полноэкранного режима
        private static Class<?> glfw;

        private static Method gl(String name, Class<?>... types) throws Exception {
            if (glfw == null) {
                // тот же GLFW, что использует игра: в NeoForge/Forge в classpath есть вторая, неинициализированная копия
                Class<?> w = cls(WINDOW);
                try {
                    if (w != null && w.getClassLoader() != null) glfw = Class.forName("org.lwjgl.glfw.GLFW", true, w.getClassLoader());
                } catch (Throwable ignored) {
                }
                if (glfw == null) glfw = cls("org.lwjgl.glfw.GLFW");
                if (glfw == null) throw new IllegalStateException("нет GLFW");
            }
            return glfw.getMethod(name, types);
        }

        private static long handle(Object window) {
            Object h = callAny(window, WINDOW, new String[]{"getWindow", "handle"});
            return h instanceof Long ? (Long) h : 0;
        }

        private static Boolean optionFullscreen(Object mc) {
            Object options = get(mc, MC, "options");
            Object v = options == null ? null : get(options, OPTIONS, "fullscreen");
            if (v instanceof Boolean) return (Boolean) v;
            Object val = v == null ? null : call(v, OPTION_INSTANCE, "get");
            return val instanceof Boolean ? (Boolean) val : null;
        }

        private static void setOptionFullscreen(Object mc, boolean on) {
            Object options = get(mc, MC, "options");
            if (options == null) return;
            Field f = field(OPTIONS, "fullscreen");
            try {
                Object v = f == null ? null : f.get(options);
                if (v instanceof Boolean) f.setBoolean(options, on);
                else if (v != null) call(v, OPTION_INSTANCE, "set", on);
                call(options, OPTIONS, "save");
            } catch (Throwable ignored) {
            }
        }

        private static boolean disabled;
        /** состояние для лаунчера (видно в диагностике) */
        static volatile String status;


        static void check(Object mc) throws Exception {
            if (disabled) return;
            Object window = call(mc, MC, "getWindow");
            if (window == null) return;
            // 26.x (окно на SDL): у игры есть свой полный экран без рамки — просто выключаем эксклюзивный
            if (methodQuiet(WINDOW, "isExclusiveFullscreen", 0) != null) {
                Object options = get(mc, MC, "options");
                Object opt = options == null || fieldQuiet(OPTIONS, "exclusiveFullscreen") == null ? null : get(options, OPTIONS, "exclusiveFullscreen");
                if (opt != null && Boolean.TRUE.equals(call(opt, OPTION_INSTANCE, "get"))) {
                    // настройка «Эксклюзивный полный экран: выкл» — игра сама переключится и сохранит её
                    call(opt, OPTION_INSTANCE, "set", false);
                    call(options, OPTIONS, "save");
                    status = "без рамки (настройка игры)";
                    System.out.println("[AuroraOverlay] полный экран без рамки (настройка игры)");
                } else if (status == null) {
                    status = "SDL, эксклюзивный=" + call(window, WINDOW, "isExclusiveFullscreen");
                }
                if (opt == null && Boolean.TRUE.equals(call(window, WINDOW, "isExclusiveFullscreen"))) {
                    call(window, WINDOW, "setExclusiveFullscreen", false);
                    System.out.println("[AuroraOverlay] полный экран без рамки (SDL)");
                }
                return;
            }
            if (methodQuiet(WINDOW, "isFullscreen", 0) == null || cls("org.lwjgl.glfw.GLFW") == null) {
                disabled = true;
                status = "недоступен: isFullscreen=" + (methodQuiet(WINDOW, "isFullscreen", 0) != null) + " GLFW=" + (cls("org.lwjgl.glfw.GLFW") != null);
                System.err.println("[AuroraOverlay] полный экран без рамки недоступен: isFullscreen=" + (methodQuiet(WINDOW, "isFullscreen", 0) != null)
                        + " GLFW=" + (cls("org.lwjgl.glfw.GLFW") != null));
                return;
            }
            long h = handle(window);
            if (h == 0) {
                status = "нет дескриптора окна";
                return;
            }
            boolean fs = Boolean.TRUE.equals(call(window, WINDOW, "isFullscreen"));

            if (pending != null) {
                if (fs) {
                    status = "ждём выхода из полного экрана";
                    return;
                }
                long monitor = pending[0];
                pending = null;
                Object mode = gl("glfwGetVideoMode", long.class).invoke(null, monitor);
                if (mode == null) return;
                int w = (Integer) mode.getClass().getMethod("width").invoke(mode);
                int hh = (Integer) mode.getClass().getMethod("height").invoke(mode);
                int[] mx = new int[1], my = new int[1];
                gl("glfwGetMonitorPos", long.class, int[].class, int[].class).invoke(null, monitor, mx, my);
                gl("glfwSetWindowAttrib", long.class, int.class, int.class).invoke(null, h, GLFW_DECORATED, 0);
                // на 1 пиксель выше экрана: иначе драйвер может снова сделать окно «эксклюзивным»
                gl("glfwSetWindowMonitor", long.class, long.class, int.class, int.class, int.class, int.class, int.class)
                        .invoke(null, h, 0L, mx[0], my[0], w, hh + 1, -1);
                borderless = true;
                status = "без рамки " + w + "x" + hh;
                System.out.println("[AuroraOverlay] полный экран без рамки " + w + "x" + hh);
                return;
            }

            if (!borderless && fs) {
                // игра в эксклюзивном полноэкранном режиме — запоминаем монитор и выходим из него
                long monitor = (Long) gl("glfwGetWindowMonitor", long.class).invoke(null, h);
                if (monitor == 0) monitor = (Long) gl("glfwGetPrimaryMonitor").invoke(null);
                if (monitor == 0) {
                    status = "нет монитора";
                    return;
                }
                call(window, WINDOW, "toggleFullScreen");
                pending = new long[]{monitor};
                status = "выход из эксклюзивного, fs=" + call(window, WINDOW, "isFullscreen");
                return;
            }

            if (borderless && fs) {
                // F11 — игра хочет в полноэкранный режим, а пользователь — выйти из него:
                // отменяем переключение и на следующей проверке ставим обычное окно
                call(window, WINDOW, "toggleFullScreen");
                setOptionFullscreen(mc, false);
                exiting = true;
                return;
            }
            if (borderless && (exiting || Boolean.FALSE.equals(optionFullscreen(mc)))) {
                // «Полный экран: выкл» в настройках или выход по F11 — возвращаем обычное окно
                borderless = false;
                exiting = false;
                gl("glfwSetWindowAttrib", long.class, int.class, int.class).invoke(null, h, GLFW_DECORATED, 1);
                long monitor = (Long) gl("glfwGetPrimaryMonitor").invoke(null);
                Object mode = monitor == 0 ? null : gl("glfwGetVideoMode", long.class).invoke(null, monitor);
                int sw = mode == null ? 1920 : (Integer) mode.getClass().getMethod("width").invoke(mode);
                int sh = mode == null ? 1080 : (Integer) mode.getClass().getMethod("height").invoke(mode);
                int w = Math.min(1280, sw), hh = Math.min(720, sh);
                gl("glfwSetWindowMonitor", long.class, long.class, int.class, int.class, int.class, int.class, int.class)
                        .invoke(null, h, 0L, (sw - w) / 2, (sh - hh) / 2, w, hh, -1);
            }
        }
    }

    // ---------------- JSON ----------------

    private static String fmt(double d) {
        if (Double.isNaN(d) || Double.isInfinite(d)) return "null";
        if (d == Math.rint(d) && Math.abs(d) < 1e15) return Long.toString((long) d);
        return String.format(java.util.Locale.ROOT, "%.3f", d);
    }

    private static String str(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }

    private static String strList(List<String> l) {
        StringBuilder b = new StringBuilder("[");
        for (int i = 0; i < l.size(); i++) {
            if (i > 0) b.append(',');
            b.append(str(l.get(i)));
        }
        return b.append(']').toString();
    }

    private static void send(OutputStream out, String line) throws Exception {
        out.write((line + "\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
    }
}
