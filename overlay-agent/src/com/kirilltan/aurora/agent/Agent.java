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
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Aurora Overlay — Java-агент (не мод). Работает с любой версией и загрузчиком:
 * через рефлексию читает позицию камеры, лут на земле, броню и предметы в руках
 * и отправляет это лаунчеру, который рисует прозрачный оверлей поверх окна игры.
 * Имена классов и методов для конкретной версии лаунчер подготавливает заранее
 * (файл маппингов), поэтому агенту не нужны зависимости от Minecraft.
 */
public final class Agent {
    private static Instrumentation inst;
    private static final Map<String, String> CLS = new HashMap<>();
    private static final Map<String, String> MEM = new HashMap<>();
    private static final Map<String, Class<?>> classCache = new HashMap<>();
    // кеш методов/полей по ссылкам на строки-константы: без сборки ключей на каждый вызов (сотни раз за кадр)
    private static final Map<String, Map<String, Object[]>> methodCache = new IdentityHashMap<>();
    private static final Map<String, Map<String, Object>> fieldCache = new IdentityHashMap<>();
    private static final Set<String> missing = new HashSet<>();
    private static final Object NONE = new Object();

    /** настройки от лаунчера (меняются на лету) */
    static volatile boolean borderlessOn;
    static volatile boolean refillOn;
    /** аварийный тотем: при здоровье не выше порога тотем из инвентаря ставится в левую руку */
    static volatile boolean totemOn;
    /** 0 — «перед смертью» (по угрозе), иначе порог здоровья в HP */
    static volatile double totemHp = 0;

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

    static Class<?> cls(String moj) {
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
            // класс игры ещё не загружен (например, ClickType до первого клика) — грузим загрузчиком игры
            if (c == null && !moj.equals(MC)) {
                Class<?> mc = classCache.get(MC);
                try {
                    if (mc != null && mc.getClassLoader() != null) c = Class.forName(name, true, mc.getClassLoader());
                } catch (Throwable ignored2) {
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

    static Method method(String moj, String name, int argc) {
        Map<String, Object[]> byName = methodCache.get(moj);
        if (byName == null) methodCache.put(moj, byName = new IdentityHashMap<>());
        Object[] byArgc = byName.get(name);
        if (byArgc == null) byName.put(name, byArgc = new Object[8]);
        Object cached = byArgc[argc];
        if (cached != null) return cached == NONE ? null : (Method) cached;
        Method found = null;
        Class<?> c = cls(moj);
        String runtime = MEM.getOrDefault(moj + "#" + name + "#" + argc, name);
        if (c != null) found = findMethod(c, runtime, argc, new HashSet<Class<?>>());
        if (found != null) access(found);
        else missing.add(moj + "." + name);
        byArgc[argc] = found == null ? NONE : found;
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

    static Field field(String moj, String name) {
        Map<String, Object> byName = fieldCache.get(moj);
        if (byName == null) fieldCache.put(moj, byName = new IdentityHashMap<>());
        Object cached = byName.get(name);
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
        byName.put(name, found == null ? NONE : found);
        return found;
    }

    static Object call(Object target, String moj, String name, Object... args) {
        Method m = method(moj, name, args.length);
        if (m == null) return null;
        try {
            return m.invoke(Modifier.isStatic(m.getModifiers()) ? null : target, args);
        } catch (Throwable e) {
            return null;
        }
    }

    static Object get(Object target, String moj, String name) {
        Field f = field(moj, name);
        if (f == null) return null;
        try {
            return f.get(Modifier.isStatic(f.getModifiers()) ? null : target);
        } catch (Throwable e) {
            return null;
        }
    }

    /** Первый найденный метод из вариантов имени (имена меняются между версиями игры). */
    static Object callAny(Object target, String moj, String[] names, Object... args) {
        for (String n : names) {
            if (methodQuiet(moj, n, args.length) != null) return call(target, moj, n, args);
        }
        return null;
    }

    static Method methodQuiet(String moj, String name, int argc) {
        boolean had = missing.contains(moj + "." + name);
        Method m = method(moj, name, argc);
        if (m == null && !had) missing.remove(moj + "." + name);
        return m;
    }

    static Field fieldQuiet(String moj, String name) {
        boolean had = missing.contains(moj + "." + name);
        Field f = field(moj, name);
        if (f == null && !had) missing.remove(moj + "." + name);
        return f;
    }

    static Object screenOf(Object mc) {
        if (fieldQuiet(MC, "screen") != null) return get(mc, MC, "screen");
        // 26.x: экран переехал в Gui
        Object gui = get(mc, MC, "gui");
        if (gui == null) return null;
        if (methodQuiet(GUI, "screen", 0) != null) return call(gui, GUI, "screen");
        return get(gui, GUI, "screen");
    }

    private static final String[] MAIN_CAMERA = {"getMainCamera", "mainCamera"};
    private static final String[] CAM_POS = {"getPosition", "position"};
    private static final String[] CAM_YAW = {"getYRot", "yRot"};
    private static final String[] CAM_PITCH = {"getXRot", "xRot"};

    private static Object cameraOf(Object mc) {
        Object gr = get(mc, MC, "gameRenderer");
        return gr == null ? null : callAny(gr, GAME_RENDERER, MAIN_CAMERA);
    }

    static double num(Object o) {
        return o instanceof Number ? ((Number) o).doubleValue() : Double.NaN;
    }

    static boolean empty(Object st) {
        return st == null || Boolean.TRUE.equals(call(st, STACK, "isEmpty"));
    }

    // ---------------- Имена классов (Mojang) ----------------

    static final String MC = "net.minecraft.client.Minecraft";
    static final String ENTITY = "net.minecraft.world.entity.Entity";
    static final String LIVING = "net.minecraft.world.entity.LivingEntity";
    static final String PLAYER = "net.minecraft.world.entity.player.Player";
    static final String INVENTORY = "net.minecraft.world.entity.player.Inventory";
    static final String MENU = "net.minecraft.world.inventory.AbstractContainerMenu";
    static final String CLICK_TYPE = "net.minecraft.world.inventory.ClickType";
    /** 26.x: ClickType → ContainerInput, handleInventoryMouseClick → handleContainerInput */
    static final String CONTAINER_INPUT = "net.minecraft.world.inventory.ContainerInput";
    static final String GAME_MODE = "net.minecraft.client.multiplayer.MultiPlayerGameMode";
    static final String ITEM_ENTITY = "net.minecraft.world.entity.item.ItemEntity";
    static final String STACK = "net.minecraft.world.item.ItemStack";
    static final String TEXT = "net.minecraft.network.chat.FormattedText";
    static final String COMPONENT = "net.minecraft.network.chat.Component";
    static final String CLEVEL = "net.minecraft.client.multiplayer.ClientLevel";
    static final String LEVEL = "net.minecraft.world.level.Level";
    static final String GAME_RENDERER = "net.minecraft.client.renderer.GameRenderer";
    static final String CAMERA = "net.minecraft.client.Camera";
    static final String VEC3 = "net.minecraft.world.phys.Vec3";
    static final String OPTIONS = "net.minecraft.client.Options";
    static final String OPTION_INSTANCE = "net.minecraft.client.OptionInstance";
    static final String WINDOW = "com.mojang.blaze3d.platform.Window";
    static final String SLOT = "net.minecraft.world.entity.EquipmentSlot";
    static final String GUI = "net.minecraft.client.gui.Gui";
    static final String ITEM = "net.minecraft.world.item.Item";
    // то, что убивает с одного раза: аварийный тотем ставим заранее
    static final String PRIMED_TNT = "net.minecraft.world.entity.item.PrimedTnt";
    static final String MINECART_TNT = "net.minecraft.world.entity.vehicle.MinecartTNT";
    static final String CREEPER = "net.minecraft.world.entity.monster.Creeper";
    static final String END_CRYSTAL = "net.minecraft.world.entity.boss.enderdragon.EndCrystal";
    static final String WARDEN = "net.minecraft.world.entity.monster.warden.Warden";

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
        boolean mac = System.getProperty("os.name", "").toLowerCase().contains("mac");
        borderlessOn = a.length > 3 && a[3].contains("b") && !mac;
        refillOn = a.length > 3 && a[3].contains("r");

        // ждём, пока игра загрузится
        Object mc = null;
        while (mc == null) {
            Thread.sleep(1000);
            if (cls(MC) == null) continue;
            methodCache.clear();
            fieldCache.clear();
            missing.clear();
            mc = call(null, MC, "getInstance");
        }
        final Object game = mc;
        Socket socket = new Socket("127.0.0.1", port);
        socket.setTcpNoDelay(true);
        OutputStream out = socket.getOutputStream();
        listen(socket, mac);
        // заранее находим всё, чтобы лаунчер знал, чего не хватает
        warmup();
        boolean refillReady = Refill.ready();
        send(out, "{\"t\":\"hello\",\"token\":" + str(token) + ",\"missing\":" + strList(new ArrayList<>(missing))
                + ",\"refill\":" + refillReady
                + (mapError != null ? ",\"error\":" + str("маппинги: " + mapError) : "") + "}");

        final AtomicReference<String> latest = new AtomicReference<>();
        final AtomicBoolean pending = new AtomicBoolean(false);
        Executor executor = game instanceof Executor ? (Executor) game : null;
        long tick = 0;
        while (true) {
            long started = System.nanoTime();
            tick++;
            // полноэкранный режим → окно без рамки (поверх эксклюзивного режима оверлей не виден)
            if (borderlessOn && executor != null && tick % 4 == 0) {
                executor.execute(() -> {
                    try {
                        Fullscreen.check(game);
                    } catch (Throwable e) {
                        Fullscreen.status = "ошибка: " + e;
                    }
                });
            }
            // снимок — на потоке игры, не чаще одного за кадр (задача выполняется в начале кадра)
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
            long sleep = 8 - (System.nanoTime() - started) / 1_000_000;
            if (sleep > 0) Thread.sleep(sleep);
        }
    }

    /** Настройки от лаунчера: строки JSON вида {"borderless":true,"refill":false}. */
    private static void listen(Socket socket, boolean mac) {
        Thread t = new Thread(() -> {
            try {
                BufferedReader r = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                for (String line; (line = r.readLine()) != null; ) {
                    if (line.contains("\"borderless\":")) borderlessOn = line.contains("\"borderless\":true") && !mac;
                    if (line.contains("\"refill\":")) refillOn = line.contains("\"refill\":true");
                    if (line.contains("\"totem\":")) totemOn = line.contains("\"totem\":true");
                    if (!totemOn) Refill.restoreSlot = -1;
                    java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"totemHp\":(-?[0-9.]+)").matcher(line);
                    if (m.find()) totemHp = Double.parseDouble(m.group(1));
                }
            } catch (Throwable ignored) {
                // лаунчер закрыл соединение
            }
        }, "Aurora-Overlay-Config");
        t.setDaemon(true);
        t.start();
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
        method(LIVING, "getMainHandItem", 0);
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
        Set<String> optional = new HashSet<>(missing);
        missing.clear();
        for (String s : optional) {
            if (!s.endsWith("getFps") && !s.endsWith(".fps")) missing.add(s);
        }
    }

    private static Object slot(String name) {
        return get(null, SLOT, name);
    }

    private static final String[] ARMOR_SLOTS = {"HEAD", "CHEST", "LEGS", "FEET"};
    private static long snapCount;
    private static String lootJson = "[]";

    private static String snapshot(Object mc) {
        snapCount++;
        StringBuilder sb = new StringBuilder(2048);
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
        if (Refill.last != null) sb.append(",\"rf\":").append(str(Refill.last));
        Object active = call(mc, MC, "isWindowActive");
        sb.append(",\"active\":").append(!Boolean.FALSE.equals(active));
        Object screen = screenOf(mc);
        sb.append(",\"screen\":").append(screen != null);
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
        double health = num(call(player, LIVING, "getHealth"));
        if (!Double.isNaN(health)) sb.append(",\"hp\":").append(fmt(health));
        sb.append(",\"pos\":[").append(fmt(px)).append(',').append(fmt(py)).append(',').append(fmt(pz)).append(',').append(fmt(num(yaw))).append(']');
        Object time = call(level, LEVEL, "getDayTime");
        if (time != null) sb.append(",\"time\":").append(fmt(num(time)));

        // камера (интерполированная — та же, что видит игрок)
        Object cam = cameraOf(mc);
        if (cam != null) {
            Object pos = callAny(cam, CAMERA, CAM_POS);
            if (pos != null) {
                sb.append(",\"cam\":[").append(fmt(num(get(pos, VEC3, "x")))).append(',').append(fmt(num(get(pos, VEC3, "y")))).append(',')
                        .append(fmt(num(get(pos, VEC3, "z")))).append(',').append(fmt(num(callAny(cam, CAMERA, CAM_YAW)))).append(',')
                        .append(fmt(num(callAny(cam, CAMERA, CAM_PITCH)))).append(']');
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

        // броня и предметы в руках
        sb.append(",\"armor\":[");
        for (int i = 0; i < ARMOR_SLOTS.length; i++) {
            Object sl = slot(ARMOR_SLOTS[i]);
            if (i > 0) sb.append(',');
            stack(sb, sl == null ? null : call(player, LIVING, "getItemBySlot", sl));
        }
        sb.append("],\"main\":");
        stack(sb, call(player, LIVING, "getMainHandItem"));
        sb.append(",\"off\":");
        stack(sb, call(player, LIVING, "getOffhandItem"));

        // угрозы рядом (TNT, крипер, кристалл…) — для аварийного тотема
        if (totemOn && snapCount % 2 == 0) {
            try {
                Refill.scanThreats(level, px, py, pz);
            } catch (Throwable ignored) {
            }
        }

        // автоподмена предметов — тоже на потоке игры, ~30 раз в секунду
        // с аварийным тотемом — каждый кадр: важна каждая доля секунды
        if ((refillOn && snapCount % 2 == 0) || totemOn) {
            try {
                Refill.tick(mc, player, screen != null);
            } catch (Throwable e) {
                Refill.last = "ошибка: " + e;
            }
        }

        // лут на земле: до 64 ближайших в радиусе 64 блоков; список обновляем ~20 раз в секунду, камеру — каждый кадр
        if (snapCount % 3 == 0) lootJson = loot(level, px, py, pz);
        sb.append(",\"loot\":").append(lootJson);
        return sb.append('}').toString();
    }

    private static String loot(Object level, double px, double py, double pz) {
        Object ents = call(level, CLEVEL, "entitiesForRendering");
        Class<?> itemCls = cls(ITEM_ENTITY);
        StringBuilder sb = new StringBuilder(1024).append('[');
        if (!(ents instanceof Iterable) || itemCls == null) return sb.append(']').toString();
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
        return sb.append(']').toString();
    }

    /** JSON предмета кешируется: название и id не меняются, а их получение — самое дорогое. */
    private static final Map<Object, Object[]> stackCache = new WeakHashMap<>();

    private static void stack(StringBuilder sb, Object st) {
        if (empty(st)) {
            sb.append("null");
            return;
        }
        Object count = call(st, STACK, "getCount");
        Object damage = Boolean.TRUE.equals(call(st, STACK, "isDamageableItem")) ? call(st, STACK, "getDamageValue") : null;
        Object[] c = stackCache.get(st);
        if (c != null && eq(c[0], count) && eq(c[1], damage)) {
            sb.append((String) c[2]);
            return;
        }
        StringBuilder b = new StringBuilder(96);
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
        b.append("{\"id\":").append(str(String.valueOf(id)))
                .append(",\"n\":").append(str(text == null ? "?" : String.valueOf(text)))
                .append(",\"c\":").append(fmt(num(count)));
        if (damage != null) {
            b.append(",\"d\":").append(fmt(num(damage)))
                    .append(",\"md\":").append(fmt(num(call(st, STACK, "getMaxDamage"))));
        }
        if (Boolean.TRUE.equals(call(st, STACK, "hasFoil"))) b.append(",\"g\":1");
        b.append('}');
        String json = b.toString();
        stackCache.put(st, new Object[]{count, damage, json});
        sb.append(json);
    }

    private static boolean eq(Object a, Object b) {
        return a == null ? b == null : a.equals(b);
    }

    // ---------------- Автоподмена предметов ----------------

    /**
     * Когда в руке закончился стак (блоки, еда), сломался инструмент/оружие, сработал тотем
     * или сломалась броня — берём такой же предмет из инвентаря, как это сделал бы игрок.
     * Действия — обычные клики по инвентарю (как у модов вроде Inventory Profiles).
     */
    static final class Refill {
        static volatile String last;
        private static int lastSel = -1;
        private static Object lastMain, lastOff;
        private static final Object[] lastArmor = new Object[4];
        private static long cooldownUntil;
        // здоровье и недавние удары — чтобы понять, что следующий удар смертелен
        private static double prevHp = -1;
        private static final long[] hitAt = new long[8];
        private static final double[] hitDmg = new double[8];
        private static int hitIdx;
        private static long lastDamageAt;
        private static long lastDangerAt;
        // что лежало в левой руке до аварийного тотема — вернём, когда опасность пройдёт
        private static int restoreSlot = -1;
        private static Object restoreItem;

        private static double recentMaxHit(long now) {
            double m = 0;
            for (int i = 0; i < hitAt.length; i++) if (now - hitAt[i] < 4000) m = Math.max(m, hitDmg[i]);
            return m;
        }

        /** Причина поставить тотем прямо сейчас или null, если смерть не грозит. */
        static volatile String threat;
        static volatile long threatAt;

        /** Взрывы и прочее, что убивает с полного здоровья: замечаем заранее по сущностям рядом. */
        static void scanThreats(Object level, double px, double py, double pz) {
            Object ents = call(level, CLEVEL, "entitiesForRendering");
            if (!(ents instanceof Iterable)) return;
            Class<?> tnt = cls(PRIMED_TNT), cart = cls(MINECART_TNT), creeper = cls(CREEPER), crystal = cls(END_CRYSTAL), warden = cls(WARDEN);
            String found = null;
            try {
                for (Object e : (Iterable<?>) ents) {
                    Class<?> c = e.getClass();
                    boolean isTnt = tnt != null && tnt.isAssignableFrom(c), isCart = cart != null && cart.isAssignableFrom(c);
                    boolean isCreeper = creeper != null && creeper.isAssignableFrom(c), isCrystal = crystal != null && crystal.isAssignableFrom(c);
                    boolean isWarden = warden != null && warden.isAssignableFrom(c);
                    if (!isTnt && !isCart && !isCreeper && !isCrystal && !isWarden) continue;
                    double x = num(call(e, ENTITY, "getX")) - px, y = num(call(e, ENTITY, "getY")) - py, z = num(call(e, ENTITY, "getZ")) - pz;
                    double d2 = x * x + y * y + z * z;
                    if (isTnt && d2 <= 10 * 10) found = "TNT рядом";
                    else if (isCart && d2 <= 8 * 8) found = "вагонетка с TNT";
                    else if (isCrystal && d2 <= 12 * 12) found = "кристалл Края";
                    else if (isWarden && d2 <= 14 * 14) found = "хранитель";
                    else if (isCreeper && d2 <= 7 * 7) {
                        // шипит (взводится) — вот-вот взорвётся
                        double swell = num(call(e, CREEPER, "getSwelling", 1.0f));
                        if (swell > 0.01 || d2 <= 3 * 3) found = "крипер";
                    }
                    if (found != null) break;
                }
            } catch (Throwable ignored) {
                // список сущностей изменился во время обхода
            }
            if (found != null) {
                threat = found;
                threatAt = System.currentTimeMillis();
            }
        }

        private static double maxHitWithin(long now, long ms) {
            double m = 0;
            for (int i = 0; i < hitAt.length; i++) if (now - hitAt[i] < ms) m = Math.max(m, hitDmg[i]);
            return m;
        }

        private static String danger(Object player, double hp, long now) {
            if (!(hp > 0)) return null;
            if (totemHp < 0) return "всегда в руке";
            if (totemHp > 0) return hp <= totemHp ? "здоровье " + (int) Math.ceil(hp) + " HP" : null;
            if (hp <= 2) return "почти нет здоровья";
            if (now - threatAt < 600 && threat != null) return threat;
            double hit = recentMaxHit(now);
            if (hit > 0 && hp <= hit + 0.5) return "следующий удар смертелен";
            // тяжёлый бой: недавно прилетело 6+ HP за удар — следующий может быть смертельным
            if (maxHitWithin(now, 10000) >= 6) return "тяжёлый бой";
            double fall = num(get(player, ENTITY, "fallDistance"));
            if (fall > 3 && fall - 3 >= hp - 0.5) return "смертельное падение";
            if (hp <= 6 && (Boolean.TRUE.equals(call(player, ENTITY, "isInLava")) || Boolean.TRUE.equals(call(player, ENTITY, "isOnFire")))) return "огонь";
            return null;
        }
        private static final String[] GET_INVENTORY = {"getInventory"};
        private static final String[] GET_SELECTED = {"getSelectedSlot"};

        private static String clickCls() {
            return cls(CLICK_TYPE) != null ? CLICK_TYPE : cls(CONTAINER_INPUT) != null ? CONTAINER_INPUT : null;
        }

        private static Method clickMethod() {
            Method m = methodQuiet(GAME_MODE, "handleInventoryMouseClick", 5);
            return m != null ? m : methodQuiet(GAME_MODE, "handleContainerInput", 5);
        }

        static boolean ready() {
            return cls(PLAYER) != null && cls(INVENTORY) != null && clickCls() != null && clickMethod() != null
                    && fieldQuiet(PLAYER, "inventoryMenu") != null && fieldQuiet(MC, "gameMode") != null && methodQuiet(INVENTORY, "getItem", 1) != null;
        }

        private static Object inventory(Object player) {
            Object inv = callAny(player, PLAYER, GET_INVENTORY);
            return inv != null ? inv : get(player, PLAYER, "inventory");
        }

        private static int selected(Object inv) {
            if (fieldQuiet(INVENTORY, "selected") != null) {
                Object v = get(inv, INVENTORY, "selected");
                if (v instanceof Integer) return (Integer) v;
            }
            Object v = callAny(inv, INVENTORY, GET_SELECTED);
            return v instanceof Integer ? (Integer) v : -1;
        }

        private static Object itemOf(Object st) {
            return empty(st) ? null : call(st, STACK, "getItem");
        }

        /** Слот инвентаря с таким же предметом: сначала рюкзак, потом хотбар. */
        private static int find(Object inv, Object item, int skip) {
            for (int i = 9; i < 36; i++) if (itemOf(call(inv, INVENTORY, "getItem", i)) == item) return i;
            for (int i = 0; i < 9; i++) if (i != skip && itemOf(call(inv, INVENTORY, "getItem", i)) == item) return i;
            return -1;
        }

        /** Номер слота в окне инвентаря игрока: хотбар — 36..44, рюкзак — 9..35. */
        private static int menuSlot(int invIndex) {
            return invIndex < 9 ? 36 + invIndex : invIndex;
        }

        private static boolean click(Object mc, Object player, int slot, int button, String type) {
            Object gm = get(mc, MC, "gameMode");
            Object menu = get(player, PLAYER, "inventoryMenu");
            Object cid = menu == null ? null : get(menu, MENU, "containerId");
            String ctCls = clickCls();
            Object ct = ctCls == null ? null : get(null, ctCls, type);
            if (gm == null || !(cid instanceof Integer) || ct == null) return false;
            Method m = clickMethod();
            if (m == null) return false;
            try {
                m.invoke(gm, cid, slot, button, ct, player);
                return true;
            } catch (Throwable e) {
                return false;
            }
        }

        private static String name(Object item) {
            String s = String.valueOf(item);
            int c = s.indexOf(':');
            return c >= 0 ? s.substring(c + 1) : s;
        }

        private static boolean isTotem(Object item) {
            return item != null && name(item).contains("totem");
        }

        /** Тотем в инвентаре: сначала рюкзак, потом хотбар. */
        private static int findTotem(Object inv) {
            for (int i = 9; i < 36; i++) if (isTotem(itemOf(call(inv, INVENTORY, "getItem", i)))) return i;
            for (int i = 0; i < 9; i++) if (isTotem(itemOf(call(inv, INVENTORY, "getItem", i)))) return i;
            return -1;
        }

        static void tick(Object mc, Object player, boolean screenOpen) {
            Object inv = inventory(player);
            if (inv == null) return;
            int sel = selected(inv);
            Object main = itemOf(call(player, LIVING, "getMainHandItem"));
            Object off = itemOf(call(player, LIVING, "getOffhandItem"));
            Object[] armor = new Object[4];
            for (int i = 0; i < 4; i++) {
                Object sl = slot(ARMOR_SLOTS[i]);
                armor[i] = sl == null ? null : itemOf(call(player, LIVING, "getItemBySlot", sl));
            }
            // кликать по своему инвентарю можно, когда ничего не открыто или открыт сам инвентарь (E);
            // в сундуке и других контейнерах сервер такие клики отклонит
            Object open = get(player, PLAYER, "containerMenu");
            boolean ownInventory = !screenOpen || (open != null && open == get(player, PLAYER, "inventoryMenu"));
            long now = System.currentTimeMillis();
            boolean acted = false;
            double hp = num(call(player, LIVING, "getHealth"));
            if (prevHp >= 0 && hp < prevHp - 0.01) {
                hitAt[hitIdx] = now;
                hitDmg[hitIdx] = prevHp - hp;
                hitIdx = (hitIdx + 1) % hitAt.length;
                lastDamageAt = now;
            }
            prevHp = hp;
            String why = totemOn ? danger(player, hp, now) : null;
            if (why != null) lastDangerAt = now;
            if (ownInventory && now >= cooldownUntil) {
                // аварийный тотем: смерть близко, а тотема в руках нет — ставим в левую руку (что там было — уходит на место тотема)
                if (totemOn && !isTotem(off) && !isTotem(main)) {
                    if (why != null) {
                        int from = findTotem(inv);
                        if (from >= 0 && click(mc, player, menuSlot(from), 40, "SWAP")) {
                            last = "тотем: " + why;
                            // запоминаем самый первый предмет за эпизод опасности (после сработавшего тотема рука уже пустая)
                            if (restoreSlot < 0) {
                                restoreSlot = from;
                                restoreItem = off;
                            }
                            acted = true;
                        }
                    }
                }
                // опасность прошла (здоровье восстановилось, урона давно не было) — возвращаем прежний предмет
                if (!acted && totemOn && restoreSlot >= 0 && isTotem(off) && hp >= 14 && now - lastDamageAt > 6000 && now - lastDangerAt > 5000) {
                    if (itemOf(call(inv, INVENTORY, "getItem", restoreSlot)) == restoreItem && click(mc, player, menuSlot(restoreSlot), 40, "SWAP")) {
                        last = "опасность прошла" + (restoreItem != null ? ": вернул " + name(restoreItem) : "");
                        acted = true;
                    }
                    restoreSlot = -1;
                    restoreItem = null;
                }
                // сработал тотем — новый в левую руку, даже в открытом инвентаре
                if (!acted && refillOn && isTotem(lastOff) && off == null) {
                    int from = findTotem(inv);
                    if (from >= 0 && click(mc, player, menuSlot(from), 40, "SWAP")) {
                        last = "в левую руку: " + name(lastOff);
                        acted = true;
                    }
                }
            }
            // остальное — только когда инвентарь закрыт: в нём игрок перекладывает вещи сам
            if (!acted && refillOn && !screenOpen && now >= cooldownUntil) {
                if (sel >= 0 && sel == lastSel && lastMain != null && main == null) {
                    int from = find(inv, lastMain, sel);
                    if (from >= 0 && click(mc, player, menuSlot(from), sel, "SWAP")) {
                        last = "в руку: " + name(lastMain);
                        acted = true;
                    }
                }
                if (!acted && lastOff != null && off == null) {
                    int from = find(inv, lastOff, -1);
                    if (from >= 0 && click(mc, player, menuSlot(from), 40, "SWAP")) {
                        last = "в левую руку: " + name(lastOff);
                        acted = true;
                    }
                }
                for (int i = 0; i < 4 && !acted; i++) {
                    if (lastArmor[i] == null || armor[i] != null) continue;
                    int from = find(inv, lastArmor[i], -1);
                    if (from >= 0 && click(mc, player, menuSlot(from), 0, "QUICK_MOVE")) {
                        last = "броня: " + name(lastArmor[i]);
                        acted = true;
                    }
                }
            }
            if (acted) cooldownUntil = now + 150;
            lastSel = sel;
            lastMain = main;
            lastOff = off;
            System.arraycopy(armor, 0, lastArmor, 0, 4);
        }
    }

    // ---------------- Полный экран без рамки ----------------

    /**
     * Эксклюзивный полноэкранный режим перекрывает все окна, поэтому оверлей в нём не виден.
     * Игра остаётся «в полном экране» (F11 и настройки работают как обычно), а агент лишь
     * подменяет эксклюзивный режим окном без рамки на весь тот же монитор.
     */
    static final class Fullscreen {
        private static final int GLFW_DECORATED = 0x00020005;
        private static final int GLFW_AUTO_ICONIFY = 0x00020006;
        private static boolean borderless;
        private static boolean disabled;
        private static Class<?> glfw;
        /** состояние для лаунчера (видно в консоли сборки) */
        static volatile String status;
        private static final String[] HANDLE = {"getWindow", "handle"};

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
            Object h = callAny(window, WINDOW, HANDLE);
            return h instanceof Long ? (Long) h : 0;
        }

        private static int[] videoMode(long monitor) throws Exception {
            Object mode = gl("glfwGetVideoMode", long.class).invoke(null, monitor);
            if (mode == null) return null;
            return new int[]{(Integer) mode.getClass().getMethod("width").invoke(mode), (Integer) mode.getClass().getMethod("height").invoke(mode)};
        }

        private static void attrib(long h, int attr, int value) throws Exception {
            gl("glfwSetWindowAttrib", long.class, int.class, int.class).invoke(null, h, attr, value);
        }

        private static void place(long h, int x, int y, int w, int hh) throws Exception {
            gl("glfwSetWindowMonitor", long.class, long.class, int.class, int.class, int.class, int.class, int.class).invoke(null, h, 0L, x, y, w, hh, -1);
        }

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
                } else if (opt == null && Boolean.TRUE.equals(call(window, WINDOW, "isExclusiveFullscreen"))) {
                    call(window, WINDOW, "setExclusiveFullscreen", false);
                    status = "без рамки (SDL)";
                }
                return;
            }
            if (methodQuiet(WINDOW, "isFullscreen", 0) == null) {
                disabled = true;
                status = "недоступен в этой версии";
                return;
            }
            long h = handle(window);
            if (h == 0) {
                status = "нет дескриптора окна";
                return;
            }
            boolean fs = Boolean.TRUE.equals(call(window, WINDOW, "isFullscreen"));
            long monitor = (Long) gl("glfwGetWindowMonitor", long.class).invoke(null, h);
            if (monitor != 0) {
                // эксклюзивный режим (запуск, F11, настройки) → окно без рамки на весь этот монитор
                int[] mode = videoMode(monitor);
                if (mode == null) return;
                int[] mx = new int[1], my = new int[1];
                gl("glfwGetMonitorPos", long.class, int[].class, int[].class).invoke(null, monitor, mx, my);
                attrib(h, GLFW_AUTO_ICONIFY, 0);
                attrib(h, GLFW_DECORATED, 0);
                // на 1 пиксель выше экрана: иначе драйвер может снова сделать окно «эксклюзивным»
                place(h, mx[0], my[0], mode[0], mode[1] + 1);
                borderless = true;
                status = "без рамки " + mode[0] + "x" + mode[1];
                System.out.println("[AuroraOverlay] полный экран без рамки " + mode[0] + "x" + mode[1]);
                return;
            }
            if (borderless && !fs) {
                // игра вышла из полного экрана (F11 / настройки) и уже вернула своё окно — возвращаем рамку
                borderless = false;
                attrib(h, GLFW_DECORATED, 1);
                status = "окно";
                int[] ww = new int[1], wh = new int[1];
                gl("glfwGetWindowSize", long.class, int[].class, int[].class).invoke(null, h, ww, wh);
                if (ww[0] < 1000 || wh[0] < 560) {
                    // игра запускалась сразу в полном экране и помнит крошечное окно — делаем 1280×720 по центру
                    long primary = (Long) gl("glfwGetPrimaryMonitor").invoke(null);
                    int[] mode = primary == 0 ? null : videoMode(primary);
                    int sw = mode == null ? 1920 : mode[0], sh = mode == null ? 1080 : mode[1];
                    int w = Math.min(1280, sw), hh = Math.min(720, sh - 80);
                    place(h, (sw - w) / 2, (sh - hh) / 2, w, hh);
                }
            }
        }
    }

    // ---------------- JSON ----------------

    /** Быстрое форматирование числа (String.format слишком медленный для сотен чисел за кадр). */
    static String fmt(double d) {
        if (Double.isNaN(d) || Double.isInfinite(d)) return "null";
        if (d == Math.rint(d) && Math.abs(d) < 1e15) return Long.toString((long) d);
        long v = Math.round(d * 1000);
        boolean neg = v < 0;
        if (neg) v = -v;
        long ip = v / 1000, fp = v % 1000;
        StringBuilder b = new StringBuilder(16);
        if (neg) b.append('-');
        b.append(ip).append('.');
        if (fp < 100) b.append('0');
        if (fp < 10) b.append('0');
        b.append(fp);
        return b.toString();
    }

    static String str(String s) {
        StringBuilder b = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
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
