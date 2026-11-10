---
name: blender
description: 用 Blender 做 3D 建模、渲染、动画。用户说「建模」「渲染」「做个 3D」「Blender」时读。重点是怎么在看不见图的情况下保证质量。
version: 1.0.0
source: handwritten
permissions: [writes-files, runs-commands]
---

# Blender：看不见图，怎么保证质量

## 先说清楚：你读不了图

当前模型不支持图像输入。渲染出来的图你看不了。
所以**不能靠「看一眼」验收**——必须用**数值和几何检查**代替。

真机日志里的教训：房子建好了，用户第一句是
> 自己检查质量！为啥树都是浮空的 还有也太粗糙了吧！！

**树浮空 = 几何上没贴地**，这是能用代码查出来的，不该等用户发现。

## 交付前必做的五项自检

写成一个 `audit.py`，每次改完跑一遍。**五项全过再交付。**

### 1. 物体是否贴地（最常见的问题）

```python
import bpy

def check_ground(threshold=-0.01):
    """所有物体最低点应接近 z=0。浮空或穿地都算错。"""
    bad = []
    for o in bpy.data.objects:
        if o.type != 'MESH':
            continue
        # 世界坐标下的最低点
        zs = [(o.matrix_world @ v.co).z for v in o.data.vertices]
        lo = min(zs)
        if lo > threshold + 0.01:      # 浮空
            bad.append((o.name, 'floating', round(lo, 3)))
        elif lo < threshold - 0.5:      # 陷太深
            bad.append((o.name, 'sunk', round(lo, 3)))
    return bad
```

### 2. 尺寸是否合理（比例失调）

```python
def check_scale():
    """用人的身高做参照：门高约 2m，房间约 3m 层高。"""
    issues = []
    for o in bpy.data.objects:
        if o.type != 'MESH': continue
        d = o.dimensions
        if max(d) > 100: issues.append((o.name, 'too big', tuple(round(x,1) for x in d)))
        if max(d) < 0.01: issues.append((o.name, 'too small', tuple(round(x,3) for x in d)))
    return issues
```

### 3. 有没有重叠/穿插

```python
def check_overlap():
    """两个物体的包围盒深度相交 = 穿模。"""
    import mathutils
    boxes = []
    for o in bpy.data.objects:
        if o.type != 'MESH': continue
        boxes.append((o.name, [o.matrix_world @ mathutils.Vector(c) for c in o.bound_box]))
    bad = []
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            n1, a = boxes[i]; n2, b = boxes[j]
            amin = [min(p[k] for p in a) for k in range(3)]
            amax = [max(p[k] for p in a) for k in range(3)]
            bmin = [min(p[k] for p in b) for k in range(3)]
            bmax = [max(p[k] for p in b) for k in range(3)]
            # 三轴都相交超过 5% 最小边长，才算真穿插（贴边不算）
            depth = [min(amax[k], bmax[k]) - max(amin[k], bmin[k]) for k in range(3)]
            if all(d > 0.05 for d in depth):
                bad.append((n1, n2, tuple(round(d, 2) for d in depth)))
    return bad
```

### 4. 面数是否失控

```python
def check_polys(limit=2_000_000):
    total = sum(len(o.data.polygons) for o in bpy.data.objects if o.type == 'MESH')
    return total, total > limit
```

用户说「精致」时容易把细分调太高，一个场景几千万面——渲染直接卡死。

### 5. 材质有没有生效

```python
def check_materials():
    missing = [o.name for o in bpy.data.objects
               if o.type == 'MESH' and (not o.data.materials or
                  all(m is None for m in o.data.materials))]
    return missing
```

全白模型通常是没材质，用户看到的就是「塑料感」。

## 用渲染结果的数值做交叉验证

图看不了，但能看**像素统计**：

```python
# 渲染后
import numpy as np
from PIL import Image
im = np.array(Image.open('out.png').convert('RGB'))
print('尺寸', im.shape)
print('平均亮度', im.mean().round(1))       # 太暗=灯光没打对
print('非背景像素占比', ((im < 250).any(axis=2)).mean().round(3))  # 物体在画面里占多少
print('颜色数', len(np.unique(im.reshape(-1,3), axis=0)))  # 几百=纯色块，几万=有细节
```

**「颜色数」是判断「精致 vs 粗糙」的廉价指标**——纯色块模型只有几百种颜色，
有贴图有反射的会到几万。

## 别在盘符根目录建工程

真机日志里两次踩：`C:\mesa`、`D:\sigma-house`。

工程目录一律：

```
%USERPROFILE%\Documents\sigma\<项目名>\
```

或者用户明确指定的路径。

## 第一件事：选对渲染引擎

真机日志里最贵的一个错误：在**集显机器上用 Cycles**，然后花十几轮
调采样数（128 → 64 → 48）想提速。方向错了——引擎的差距是数量级的，
参数只能救回一点。

### 怎么选

```python
import bpy
# 先看有没有可用的 GPU 计算设备
prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.refresh_devices()
gpus = [d for d in prefs.devices if d.type != 'CPU']
has_cuda = any(d.type == 'CUDA' for d in gpus)
has_optix = any(d.type == 'OPTIX' for d in gpus)
```

| 硬件 | 引擎 | 理由 |
|---|---|---|
| **集显 / 虚拟显卡 / 无独显** | **EEVEE** | Cycles 只能 CPU 软算，慢 10–50 倍 |
| NVIDIA + CUDA/OptiX | Cycles | 硬件光追，质量最好 |
| AMD 独显 + HIP | Cycles | 可用但生态弱 |
| 要真实焦散 / 次表面散射 | Cycles | EEVEE 做不到 |

**集显上不要用 Cycles，除非用户明确要求光追效果。**

### 切换命令

```python
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE_NEXT'   # Blender 4.2+
# 或 'BLENDER_EEVEE'（4.1 及更早）

# EEVEE 的关键参数：采样数 32–64 就够，TAA 抗锯齿
sc.eevee.taa_render_samples = 32
# 开启屏幕空间反射/环境光遮蔽补偿没有光追的损失
sc.eevee.use_ssr = True
sc.eevee.use_gtao = True
```

### 如果用户必须要 Cycles（要质感）

那就要接受慢，并把预期说清楚：

```python
sc.cycles.device = 'CPU'
sc.cycles.samples = 32            # 集显机器 32 起步，别 128
sc.render.resolution_percentage = 50   # 先出一半分辨率看构图
```

**先出 480p 低采样预览给用户确认构图，再跑全质量。**
不要一上来就 1080p/128 采样跑一小时。

### 真机教训

用户问「为什么 GPU 占用很低」——答案是**集显 + Cycles = 纯 CPU 渲染**，
GPU 本来就不参与。当时模型去跑了 2 分钟 benchmark 才得出这个结论，
而机器画像里早就有「AMD Radeon Graphics（集显）」。

**看到集显就选 EEVEE，不要先跑基准测试再说。**

### ⚠ 换机器了必须重采画像

真机日志里发生过：用户换了一台机器（从集成显卡的 Ryzen 4700U 换成
Xeon E5-2686 v4 + GTX 1060），但前面的判断还停留在旧机器上——

- 说的还是「这台是集显，Cycles 只能 CPU」
- 实际新机器 GPU 占用 99%，跑的是 CUDA

**判断渲染引擎前，先确认主机名和显卡是不是画像里那一台。**
主机名变了就重采，别拿旧结论套新机器。

```sh
pc.mjs info | grep -E "name|hostname"
```

### 别把「优化层」写成「硬件特性」

真机日志里交付说明写的是「OptiX 降噪」，但模型自己在后面补了一句：

> GTX 1060 是 Pascal 架构，OptiX 对它只是兼容层，并非原生支持，所以 CUDA 更快。
> 脚本已固定使用 CUDA。

**实际用的是 CUDA，标注却写 OptiX。** 用户看到会以为显卡支持光追降噪
（Pascal 不支持硬件光追）。

交付说明里只写**实际生效的设置**，不要把「考虑过的方案」写进结果描述。

## 「太卡通」怎么修：按影响排序

真机日志里用户的原话：

> 你说 blender 能不能做 想现实真实场景那样的 你这个太卡通

模型回答「责任在我用的方法，不在 Blender」——这句是对的。但接下来
只去做「下载 PBR 素材」一件事，不够。

**卡通感有四个来源，按影响从大到小：**

### 1. 材质：没有真实 PBR（影响最大）

程序化材质（纯色 + 一点点粗糙度）是卡通感的第一来源。

```python
# 检查：有多少材质带真实贴图？
def check_pbr():
    plain = []
    for m in bpy.data.materials:
        if not m.use_nodes: continue
        has_tex = any(n.type in ('TEX_IMAGE', 'TEX_ENVIRONMENT')
                      for n in m.node_tree.nodes)
        if not has_tex:
            plain.append(m.name)
    return plain      # 非空就是「一眼假」
```

**修法**：从 Poly Haven / ambientCG 拿 **CC0** 的 PBR 套装，
每个材质至少要有：

| 贴图 | 作用 | 缺了会怎样 |
|---|---|---|
| Base Color | 颜色 | 纯色 = 塑料 |
| Roughness | 粗糙度 | 全场均匀反光 = 假 |
| Normal | 表面起伏 | 完全平滑 = 假 |
| **Ambient Occlusion** | 缝隙阴影 | 接缝处没暗角 = 浮 |

**一张 base color 是不够的。** 只有颜色没有粗糙度和法线，还是塑料感。

### 2. 光照：单一光源最假

默认的「一个太阳 + 纯环境光」= 硬邦邦的卡通光照。

真实场景的光照结构：

```python
# 三点光 + HDRI 环境
bpy.ops.object.light_add(type='AREA', location=(3, -3, 4))   # key
key = bpy.context.object
key.data.energy = 500
key.data.size = 2.0        # 面积光，不是点光——点光阴影太锐

bpy.ops.object.light_add(type='AREA', location=(-4, -2, 2))  # fill
bpy.context.object.data.energy = 150
bpy.context.object.data.size = 3.0

bpy.ops.object.light_add(type='AREA', location=(0, 4, 3))    # rim
bpy.context.object.data.energy = 300

# 环境光用 HDRI 而不是纯色
world = bpy.context.scene.world
world.use_nodes = True
env = world.node_tree.nodes.new('ShaderNodeTexEnvironment')
env.image = bpy.data.images.load('studio.hdr')
```

**关键：面积光（AREA）而不是点光（POINT）。** 点光的阴影边缘像刀切，
面积光才有柔和的过渡——这是「真实感」的核心。

### 3. 相机：套用摄影参数

```python
cam = bpy.context.scene.camera.data
cam.lens = 35              # 不是默认 50，35-50 更像人眼
cam.dof.use_dof = True     # 开启景深！
cam.dof.aperture_fstop = 2.8
cam.dof.focus_distance = 5.0
```

**景深是最便宜的「真实感」开关。** 卡通渲染通常全景清晰，
而真实照片一定有虚化。

### 4. 色彩管理：别用 Standard

```python
scene = bpy.context.scene
scene.view_settings.view_transform = 'AgX'    # 4.x 默认，电影感
# 或 'Filmic'（3.x）
scene.view_settings.look = 'AgX - Medium High Contrast'
```

`Standard` 会让高光直接爆白、颜色过饱和——那就是「塑料感」的来源之一。

### 渲染设置（GTX 1060 这类入门独显）

```python
sc.cycles.device = 'GPU'
sc.cycles.samples = 64              # 有降噪的话 64 够，不必 512
sc.cycles.use_denoising = True
sc.cycles.denoiser = 'OPENIMAGEDENOISE'   # CPU 降噪，任何显卡都能用
sc.render.resolution_x = 1600
sc.render.resolution_y = 1000
```

**512 采样 + 无降噪 是最浪费的组合**：慢 8 倍，噪点还不一定少。
**64 采样 + OIDN 降噪** 通常比 512 采样裸渲染更干净。

### 交付前问自己四个问题

1. 每个材质都有 base/rough/normal 三张图吗？
2. 主光是不是面积光？有没有补光？
3. 开了景深吗？
4. 色彩管理是 AgX/Filmic 还是 Standard？

**四个里缺两个以上，用户一定会说「太卡通」。**

## 渲染前先估算时间

```python
# Cycles 单帧粗估：像素数 × 采样数 × 复杂度系数 / 硬件系数
# 软件渲染（无独显）大约 1000 px²·sample / 秒
frame_seconds = (1920 * 1080 * 64) / 1000 / 60   # ≈ 36 分钟/帧（软件渲染）
```

**算出来超过 5 分钟/帧就告诉用户**，别闷头跑两小时。
真机日志里最长一轮 35 分钟，用户催了 4 次。

## 三条铁律

1. **交付前跑完五项自检**，尤其「贴地」——这是用户第一眼会看的
2. **算时间**，超过 5 分钟/帧先报告预期
3. **工程放用户目录**，不放盘符根
