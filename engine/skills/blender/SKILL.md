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
