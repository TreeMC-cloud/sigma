# -*- coding: utf-8 -*-
"""
通用「贴合」工具 —— 把 B 装到 A 上，自动解算位置和朝向。

为什么需要：真机日志里为了「让机甲握住枪」，先写 solve_reach.py 解算臂展、
再写 add_weapon.py 算握持点、又写 rnd_gun.py 渲染验证。三次往返只为一件事。

这类需求反复出现：
  · 武器贴手（手握）
  · 配件贴装备（贴面）
  · 家具贴地（落地）
  · 灯具贴天花板（吊挂）

统一成四个模式，调用一次算完：

    attach(a_name='Hand.R', b_name='Gun', mode='grip')
    attach(a_name='Wall', b_name='Painting', mode='surface')
    attach(a_name='Floor', b_name='Chair', mode='ground')
    attach(a_name='Ceiling', b_name='Lamp', mode='hang')

设计原则：
  · 只算变换，不修改网格 —— 出问题能一键回退
  · 返回可验证的数值（位移、旋转、最终间隙），不返回「大概好了」
  · 每个模式都有「对齐后自检」，间隙超阈值就警告
"""

import bpy
import math
import mathutils

Vec = mathutils.Vector


def _bbox_world(obj):
    """物体在世界坐标下的 8 个角点。"""
    return [obj.matrix_world @ Vec(c) for c in obj.bound_box]


def _aabb(obj):
    pts = _bbox_world(obj)
    lo = Vec((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vec((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def _center(obj):
    lo, hi = _aabb(obj)
    return (lo + hi) / 2


def _bone_head_world(arm_obj, bone_name):
    """骨骼头部的世界坐标（握持点通常在这里附近）。"""
    bone = arm_obj.data.bones.get(bone_name)
    if not bone:
        raise ValueError('找不到骨骼：%s' % bone_name)
    return arm_obj.matrix_world @ bone.head_local


def attach(a_name, b_name, mode='grip', offset=(0, 0, 0),
           bone=None, gap=0.0, align_rotation=True, dry_run=False):
    """
    把 B 贴到 A 上。

    a_name : 参照物名字（物体名，或骨骼所属的 armature 名）
    b_name : 要移动的物体名
    mode   : grip / surface / ground / hang
    offset : 贴合后再加的偏移（世界坐标，米）
    bone   : mode='grip' 时指定握持骨骼（如 'Hand.R'）
    gap    : 期望的间隙（surface/hang 用；0 = 严丝合缝）
    dry_run: True 只算不动，返回计划

    返回 dict：{ok, moved_to, rotated_by, final_gap, warnings}
    """
    a = bpy.data.objects.get(a_name)
    b = bpy.data.objects.get(b_name)
    if not b:
        raise ValueError('找不到要移动的物体：%s' % b_name)

    warnings = []
    result = {'ok': True, 'mode': mode, 'a': a_name, 'b': b_name,
              'warnings': warnings, 'dry_run': dry_run}

    # ---- 1. 算目标位置 ----
    if mode == 'grip':
        if not a or a.type != 'ARMATURE':
            # a 可能直接给的是骨骼所属 armature 的名字
            arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
            if len(arms) == 1:
                a = arms[0]
                warnings.append('a_name 不是 armature，自动用了唯一的骨骼物体 %s' % a.name)
            else:
                raise ValueError('grip 模式需要 armature；找到 %d 个，请用 bone= 指定' % len(arms))
        if not bone:
            raise ValueError("grip 模式必须给 bone='Hand.R' 这样的握持骨骼名")
        target = _bone_head_world(a, bone)
        # 让 B 的握持中心（默认几何中心）落到骨骼头部
        b_center = _center(b)
        delta = target - b_center

    elif mode == 'surface':
        if not a:
            raise ValueError('surface 模式需要参照物 A')
        a_lo, a_hi = _aabb(a)
        b_lo, b_hi = _aabb(b)
        # 贴在 A 的 +Y 面上（最常见的「挂墙上」），并居中
        a_center = (a_lo + a_hi) / 2
        b_center = (b_lo + b_hi) / 2
        target = Vec((a_center.x, a_hi.y + gap + (b_hi.y - b_lo.y) / 2, a_center.z))
        delta = target - b_center

    elif mode == 'ground':
        if not a:
            # 没给 A 就用世界原点平面
            a_top = 0.0
        else:
            a_lo, a_hi = _aabb(a)
            a_top = a_hi.z
        b_lo, _ = _aabb(b)
        delta = Vec((0, 0, a_top + gap - b_lo.z))

    elif mode == 'hang':
        if not a:
            raise ValueError('hang 模式需要天花板物体 A')
        a_lo, a_hi = _aabb(a)
        b_lo, b_hi = _aabb(b)
        a_center = (a_lo + a_hi) / 2
        b_center = (b_lo + b_hi) / 2
        target = Vec((a_center.x, a_center.y, a_lo.z - gap - (b_hi.z - b_lo.z) / 2))
        delta = target - b_center

    else:
        raise ValueError('mode 必须是 grip / surface / ground / hang')

    delta = delta + Vec(offset)
    result['moved_to'] = [round(v, 4) for v in (b.location + delta)]

    # ---- 2. 对齐朝向（可选） ----
    rot_before = b.rotation_euler.copy()
    if align_rotation:
        if mode == 'grip' and a and a.type == 'ARMATURE' and bone:
            # 让 B 的 +Y 轴对齐骨骼方向（枪口朝前）
            pb = a.pose.bones.get(bone)
            if pb:
                world_dir = (a.matrix_world.to_3x3() @ (pb.tail - pb.head)).normalized()
                # 计算把 +Y 转到 world_dir 的旋转
                z = Vec((0, 0, 1))
                quat = Vec((0, 1, 0)).rotation_difference(world_dir)
                b.rotation_mode = 'QUATERNION'
                b.rotation_quaternion = quat
        # surface/ground/hang 默认不动旋转：贴墙的画不该被转

    if not dry_run:
        b.location = b.location + delta
        bpy.context.view_layer.update()

    result['rotated_by'] = [round(math.degrees(v), 2)
                            for v in (b.rotation_euler - rot_before)]

    # ---- 3. 自检：算贴合后的实际间隙 ----
    if not dry_run:
        if mode in ('ground', 'hang'):
            b_lo, b_hi = _aabb(b)
            surf = a_hi.z if mode == 'ground' and a else (a_lo.z if a else 0.0)
            actual = b_lo.z - surf if mode == 'ground' else surf - b_hi.z
            result['final_gap'] = round(actual, 4)
            if abs(actual - gap) > 0.05:
                warnings.append('期望间隙 %.3f，实际 %.3f' % (gap, actual))
        elif mode == 'surface':
            b_lo, b_hi = _aabb(b)
            a_lo, a_hi = _aabb(a)
            actual = b_lo.y - a_hi.y
            result['final_gap'] = round(actual, 4)
            if abs(actual - gap) > 0.05:
                warnings.append('期望间隙 %.3f，实际 %.3f' % (gap, actual))
        elif mode == 'grip':
            target = _bone_head_world(a, bone) + Vec(offset)
            dist = (Vec(result['moved_to']) - target).length
            result['final_gap'] = round(dist, 4)
            if dist > 0.15:
                warnings.append('握持点偏离骨骼 %.3f 米，可能穿模或悬空' % dist)

    result['ok'] = len(warnings) == 0
    return result


def attach_many(plan):
    """
    批量贴合。plan = [{'a':..., 'b':..., 'mode':..., ...}, ...]
    一次算完一组，避免逐个往返。
    """
    out = []
    for item in plan:
        kw = dict(item)
        a = kw.pop('a', None)
        b = kw.pop('b', None)
        out.append(attach(a, b, **kw))
    return out


if __name__ == '__main__':
    import json
    # 例：让 Gun 贴到 Hand.R
    print(json.dumps(attach('Mech', 'Gun', mode='grip', bone='Hand.R', dry_run=True),
                     ensure_ascii=False, indent=2))
