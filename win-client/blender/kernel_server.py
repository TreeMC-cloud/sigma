# -*- coding: utf-8 -*-
"""
Blender 常驻 kernel —— 让 pc.mjs 反复发命令而不用重启 Blender。

为什么需要它：每次 `pc.mjs ps "blender -b file.blend -P cmd.py"` 都要
重新启动 Blender、加载 .blend、初始化插件，一个中等场景 30-60 秒。
连续调试时 90% 的时间都花在加载上。

做法：Blender 里跑一个 while 循环，监听本地 TCP 端口，
收到一行 JSON 就 exec 里面的 Python，把结果写回。场景一直开着。

协议（每行一个 JSON）：
  请求: {"id": 1, "code": "bpy.ops.mesh.primitive_cube_add()"}
  响应: {"id": 1, "ok": true, "out": "...", "ms": 12}

  {"id": 2, "code": "print(len(bpy.data.objects))"}   → out 里是 stdout
  {"id": 3, "code": "__QUIT__"}                        → 关闭 kernel

用法（在 Blender 里执行一次）：
  blender -b scene.blend -P kernel_server.py -- --port 9821
或者在 GUI 的 Scripting 工作区里 Run Script。
"""

import bpy
import sys
import json
import time
import socket
import threading
import traceback
import io
import os

HOST = '127.0.0.1'      # 只监听本机：kernele 只服务同一台机器上的 DSH
DEFAULT_PORT = 9821


class _Out:
    """把 print 的输出收集起来，一起回给调用方。"""

    def __init__(self):
        self.buf = io.StringIO()

    def write(self, s):
        try:
            self.buf.write(s)
        except Exception:
            pass
        return len(s)

    def flush(self):
        pass

    def getvalue(self):
        return self.buf.getvalue()


def run_code(code):
    """执行一段 Python，返回 (ok, out)。"""
    out = _Out()
    old = sys.stdout
    sys.stdout = out
    t0 = time.time()
    ok = True
    try:
        # 用 exec 而不是 eval：允许多行语句、import、赋值
        exec(compile(code, '<kernel>', 'exec'), {'bpy': bpy, '__name__': '__kernel__'})
    except Exception:
        ok = False
        out.write(traceback.format_exc())
    finally:
        sys.stdout = old
    return ok, out.getvalue(), int((time.time() - t0) * 1000)


def serve(port):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((HOST, port))
    srv.listen(4)
    print('[kernel] listening on %s:%d' % (HOST, port))
    sys.stdout.flush()

    while True:
        try:
            conn, _addr = srv.accept()
        except Exception as e:
            print('[kernel] accept failed: %s' % e)
            break

        f = conn.makefile('rwb')
        try:
            while True:
                line = f.readline()
                if not line:
                    break
                try:
                    req = json.loads(line.decode('utf-8'))
                except Exception:
                    f.write((json.dumps({'ok': False, 'out': 'bad json'}) + '\n').encode())
                    f.flush()
                    continue

                rid = req.get('id')
                code = req.get('code', '')

                if code.strip() == '__QUIT__':
                    f.write((json.dumps({'id': rid, 'ok': True, 'out': 'bye'}) + '\n').encode())
                    f.flush()
                    conn.close()
                    srv.close()
                    return

                ok, out, ms = run_code(code)
                resp = {'id': rid, 'ok': ok, 'out': out, 'ms': ms}
                f.write((json.dumps(resp) + '\n').encode())
                f.flush()
        except Exception as e:
            print('[kernel] conn error: %s' % e)
        finally:
            try:
                f.close()
                conn.close()
            except Exception:
                pass


def main():
    argv = sys.argv
    port = DEFAULT_PORT
    if '--' in argv:
        rest = argv[argv.index('--') + 1:]
        for i, a in enumerate(rest):
            if a == '--port' and i + 1 < len(rest):
                port = int(rest[i + 1])

    # 后台线程跑服务，主线程留给 Blender（GUI 模式下主线程必须让出来）
    t = threading.Thread(target=serve, args=(port,), daemon=True)
    t.start()
    print('[kernel] started, port=%d' % port)


if __name__ == '__main__':
    main()
