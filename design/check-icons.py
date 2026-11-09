"""图标体检：找出「多图标叠在一起」的 SVG。
判据：
  1. 文件里出现多个 <svg>
  2. 有两条 path 的 d 完全重复（同一图标被画了两遍）
  3. 元素数 > 8
"""
import re, sys, glob, os, collections

def check(path):
    s = open(path, encoding='utf-8', errors='replace').read()
    issues = []
    if s.count('<svg') > 1: issues.append(f'multi-svg({s.count("<svg")})')
    ds = re.findall(r'<path[^>]*\bd="([^"]+)"', s)
    dup = [d for d, n in collections.Counter(ds).items() if n > 1]
    if dup: issues.append(f'dup-path({len(dup)})')
    elems = len(re.findall(r'<(path|circle|rect|polygon|line|ellipse)\b', s))
    if elems > 8: issues.append(f'elements({elems})')
    return issues

root = sys.argv[1]
files = sorted(glob.glob(os.path.join(root, '*.svg')))
bad = []
for f in files:
    i = check(f)
    if i: bad.append((os.path.basename(f), ' '.join(i)))
print(f'{root}: {len(files)} 个文件，{len(bad)} 个有问题')
for n, i in bad[:12]: print('  ', n, i)
if len(bad) > 12: print('   ...')
