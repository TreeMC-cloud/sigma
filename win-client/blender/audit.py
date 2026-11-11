# -*- coding: utf-8 -*-
"""
Blender 装配审计 —— 把「浮空/穿模/太糙」变成可判定的检查。

为什么单写一个文件：真机上「树都是浮空的」「太粗糙了」这类反馈出现了多次，
每次都靠人眼看。这个脚本把五类问题量化，交付前跑一遍即可。

用法（在 kernel 里跑，或 headless）：
    exec(open(r'D:\\sigma-house\\audit.py').read())
    report = audit_all()
    print(json.dumps(report, ensure_ascii=False, indent=2))

设计原则：
  · 阻断级问题（浮空、穿模）必须为空才允许交付
  · 质量级问题（比例、面数、材质）报告给用户判断
  · 每个检查都要**能失败**，否则是装饰
"""

import bpy
import json
import math
import mathutils


def _world_bounds(obj):
    """物体在世界坐标下的 AABB（min, max）。"""
    corners = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]
    lo = [min(c[i] for c in corners) for i in range(3)]
    hi = [max(c[i] for c in corners) for i in range(3)]
    return lo, hi


def check_ground(eps=0.02):
    """
    阻断级：物体是否贴地。

    判据：最低点 |z| 应小于 eps。
      · z > eps        → 浮空（真机日志里的「树都是浮空的」）
      · z < -0.5       → 陷进地里

    注意：吊灯、挂画这类本来就该悬空的物体，名字里带 lamp/picture/light
    的跳过（下划线开头的物体也跳过，那是辅助对象）。
    """
    SKIP = ('lamp', 'light', 'picture', 'paint', 'ceiling', 'lamp')
    bad = []
    for o in bpy.data.objects:
        if o.type != 'MESH':
            continue
        name = o.name.lower()
        if name.startswith('_') or any(k in name for k in SKIP):
            continue
        lo, hi = _world_bounds(o)
        z = lo[2]
        if z > eps:
            bad.append({'object': o.name, 'issue': 'floating', 'z': round(z, 3)})
        elif z < -0.5:
            bad.append({'object': o.name, 'issue': 'sunk', 'z': round(z, 3)})
    return bad


def check_overlap(min_ratio=0.05):
    """
    阻断级：两个物体是否深度穿插。

    判据：AABB 三轴都相交，且每轴交叠深度 > min_ratio × 较小边长。
    只是贴边不算穿模，所以要求「三轴都过」。
    """
    meshes = [o for o in bpy.data.objects if o.type == 'MESH' and not o.name.startswith('_')]
    boxes = []
    for o in meshes:
        lo, hi = _world_bounds(o)
        boxes.append((o.name, lo, hi))

    bad = []
    for i in range(len(boxes)):
        n1, lo1, hi1 = boxes[i]
        for j in range(i + 1, len(boxes)):
            n2, lo2, hi2 = boxes[j]
            depth = [min(hi1[k], hi2[k]) - max(lo1[k], lo2[k]) for k in range(3)]
            if all(d > 0 for d in depth):
                # 用较小物体的尺寸做尺度，避免大物体吞小物体时误判
                s1 = [hi1[k] - lo1[k] for k in range(3)]
                s2 = [hi2[k] - lo2[k] for k in range(3)]
                small = min(max(s1), max(s2))
                if small > 0 and all(d > small * min_ratio for d in depth):
                    bad.append({'a': n1, 'b': n2,
                                'depth': [round(d, 3) for d in depth]})
    return bad


def check_scale(max_dim=100.0, min_dim=0.01):
    """质量级：尺寸是否离谱（用米做单位时，100m 以上的单体基本是错的）。"""
    bad = []
    for o in bpy.data.objects:
        if o.type != 'MESH':
            continue
        d = o.dimensions
        big = max(d)
        if big > max_dim:
            bad.append({'object': o.name, 'issue': 'too_big', 'dim': round(big, 2)})
        elif 0 < big < min_dim:
            bad.append({'object': o.name, 'issue': 'too_small', 'dim': round(big, 4)})
    return bad


def check_polys(limit=2_000_000):
    """质量级：总面数。超了渲染会很慢，明细告诉用户是哪几个物体。"""
    rows = []
    total = 0
    for o in bpy.data.objects:
        if o.type != 'MESH':
            continue
        n = len(o.data.polygons)
        total += n
        rows.append({'object': o.name, 'polys': n})
    rows.sort(key=lambda r: -r['polys'])
    return {'total': total, 'over_limit': total > limit, 'top': rows[:10]}


def check_materials():
    """阻断级：有没有物体没材质（全白 = 一眼假）。"""
    missing = []
    for o in bpy.data.objects:
        if o.type != 'MESH':
            continue
        mats = [m for m in o.data.materials if m is not None]
        if not mats:
            missing.append(o.name)
    return missing


def check_pbr_textures():
    """
    质量级：材质里有没有真实贴图。

    只有 base color 没有 roughness/normal，视觉上仍然是塑料。
    这里统计每个材质的贴图种类数，少于 2 种的列出来。
    """
    thin = []
    for m in bpy.data.materials:
        if not m.use_nodes:
            continue
        kinds = set()
        for n in m.node_tree.nodes:
            if n.type == 'TEX_IMAGE' and n.image:
                # 用图片名猜用途
                nm = (n.image.name or '').lower()
                if 'normal' in nm or 'nrm' in nm:
                    kinds.add('normal')
                elif 'rough' in nm:
                    kinds.add('roughness')
                elif 'metal' in nm:
                    kinds.add('metallic')
                elif 'ao' in nm or 'occlusion' in nm:
                    kinds.add('ao')
                else:
                    kinds.add('color')
        if len(kinds) < 2:
            thin.append({'material': m.name, 'maps': sorted(kinds)})
    return thin


def check_uv():
    """阻断级：要烘焙就必须有 UV。没 UV 的物体会被跳过，导致烘焙出黑图。"""
    no_uv = []
    for o in bpy.data.objects:
        if o.type != 'MESH':
            continue
        if not o.data.uv_layers:
            no_uv.append(o.name)
    return no_uv


def check_rig():
    """
    阻断级：骨骼绑定是否完整。人物/机甲类任务必查。

    真机日志里的需求：「你要绑定骨骼」。绑了但没绑全，动作就会散架。
    三类问题：
      · 有 armature 但某些 mesh 没挂 Armature 修改器 → 那个部件不会跟着动
      · 顶点组里没有对应骨骼的名字 → 权重无效
      · 有顶点组但权重全 0 → 视觉上等于没绑
    """
    arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    if not arms:
        return {'has_armature': False, 'issues': []}

    arm = arms[0]
    bone_names = {b.name for b in arm.data.bones}
    issues = []

    for o in bpy.data.objects:
        if o.type != 'MESH':
            continue
        mods = [m for m in o.modifiers if m.type == 'ARMATURE' and m.object == arm]
        if not mods:
            issues.append({'object': o.name, 'issue': 'no_armature_modifier'})
            continue
        groups = {g.name for g in o.vertex_groups}
        if not groups:
            issues.append({'object': o.name, 'issue': 'no_vertex_groups'})
            continue
        orphan = groups - bone_names
        if orphan:
            issues.append({'object': o.name, 'issue': 'orphan_groups',
                           'groups': sorted(orphan)[:5]})
        # 权重全 0 的组等于没绑
        zero = []
        for g in o.vertex_groups:
            if g.name not in bone_names:
                continue
            has_weight = False
            for v in o.data.vertices:
                for ge in v.groups:
                    if ge.group == g.index and ge.weight > 0.0001:
                        has_weight = True
                        break
                if has_weight:
                    break
            if not has_weight:
                zero.append(g.name)
        if zero:
            issues.append({'object': o.name, 'issue': 'zero_weight_groups',
                           'groups': zero[:5]})

    return {
        'has_armature': True,
        'armature': arm.name,
        'bones': len(bone_names),
        'issues': issues,
    }


def check_animation(frame_range=None):
    """
    质量级：动画曲线的完整性。

    走路动画最常见的两个毛病：
      · 起始帧脚离地（真机日志里 0.073 米）
      · 关键帧太少导致动作发僵
    """
    out = {'actions': [], 'issues': []}
    for act in bpy.data.actions:
        out['actions'].append({
            'name': act.name,
            'curves': len(act.fcurves),
            'frames': [int(round(act.frame_range[0])), int(round(act.frame_range[1]))],
        })
        # 曲线太少 → 动作僵硬
        if len(act.fcurves) < 6:
            out['issues'].append({'action': act.name, 'issue': 'too_few_curves',
                                  'curves': len(act.fcurves)})
    return out


def audit_all(poly_limit=2_000_000):
    """
    跑全部检查，返回分级的报告。

    gate = False 表示有阻断级问题，**不允许交付**。
    """
    ground = check_ground()
    overlap = check_overlap()
    scale = check_scale()
    polys = check_polys(poly_limit)
    no_mat = check_materials()
    thin_mat = check_pbr_textures()
    no_uv = check_uv()
    rig = check_rig()
    anim = check_animation()

    blockers = []
    if ground:
        blockers.append({'check': 'ground', 'count': len(ground), 'detail': ground})
    if overlap:
        blockers.append({'check': 'overlap', 'count': len(overlap), 'detail': overlap})
    if no_mat:
        blockers.append({'check': 'material_missing', 'count': len(no_mat), 'detail': no_mat})
    if no_uv:
        blockers.append({'check': 'uv_missing', 'count': len(no_uv), 'detail': no_uv})
    # 骨骼：只有「明确有 armature 但绑定不全」才算阻断；
    # 纯静态场景没有骨骼是正常的
    if rig.get('has_armature') and rig.get('issues'):
        blockers.append({'check': 'rig', 'count': len(rig['issues']), 'detail': rig})

    quality = []
    if scale:
        quality.append({'check': 'scale', 'count': len(scale), 'detail': scale})
    if polys['over_limit']:
        quality.append({'check': 'polys', 'count': polys['total'], 'detail': polys['top']})
    if thin_mat:
        quality.append({'check': 'pbr_thin', 'count': len(thin_mat), 'detail': thin_mat})

    report = {
        'gate': len(blockers) == 0,
        'blockers': blockers,
        'quality': quality,
        'stats': {
            'objects': len([o for o in bpy.data.objects if o.type == 'MESH']),
            'polys': polys['total'],
            'materials': len(bpy.data.materials),
            'rig': rig,
            'animation': anim,
        },
    }
    return report


if __name__ == '__main__':
    print(json.dumps(audit_all(), ensure_ascii=False, indent=2))
