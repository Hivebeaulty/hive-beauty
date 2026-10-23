#!/usr/bin/env python3
"""Contraste WCAG das cores do design system (app/globals.css) nos temas claro e Grafite.
Uso: python3 scripts/contrast-check.py [arquivos .tsx ...]
Sem arquivos: imprime a matriz texto x fundo. Com arquivos: confere as combinações
text-* x bg-* usadas e acusa as que ficam abaixo de 4,5:1 (texto normal)."""
import re, sys, itertools
css = open("app/globals.css").read()
def block(sel):
    m = re.search(re.escape(sel) + r"\s*\{(.*?)\n\}", css, re.S)
    return dict(re.findall(r"--c-([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+);", m.group(1))) if m else {}
def parse(sel):
    return {k: tuple(map(int, v)) for k, v in ((k, v) for k, *v in [(k, *v) for k, v in [(m[0], m[1:]) for m in re.findall(r"--c-([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+);", re.search(re.escape(sel) + r"\s*\{(.*?)\n\}", css, re.S).group(1))]])}
THEMES = {"claro": parse(":root"), "grafite": parse('[data-theme="dark"]')}
def lum(c):
    def ch(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = c; return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
def ratio(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True); return (la + 0.05) / (lb + 0.05)
def mix(fg, bg, alpha):  # cor com transparência sobre um fundo
    return tuple(round(f * alpha + b * (1 - alpha)) for f, b in zip(fg, bg))
def color(theme, name):
    t = THEMES[theme]; base, _, a = name.partition("/")
    key = {"cream": "cream-DEFAULT", "sand": "sand-DEFAULT", "primary": "primary", "primary-ink": "primary-ink"}.get(base, base)
    if key not in t: return None
    c = t[key]
    return mix(c, t["surface"], int(a) / 100) if a else c
TEXT = ["ink-300", "ink-400", "ink-500", "ink-600", "ink-700", "ink-800", "success", "warning", "danger", "primary-ink"]
BG = ["surface", "cream", "sand", "ink-50", "primary", "danger/10", "danger/5"]
if len(sys.argv) == 1:
    for th in THEMES:
        print(f"\n== {th} (texto x fundo; * = abaixo de 4,5)")
        print("".ljust(12) + "".join(b.ljust(11) for b in BG))
        for t in TEXT:
            row = t.ljust(12)
            for b in BG:
                fg, bg = color(th, t), color(th, b)
                r = ratio(fg, bg); row += (f"{r:4.1f}{'*' if r < 4.5 else ' '}").ljust(11)
            print(row)
    sys.exit(0)
bad = 0
for f in sys.argv[1:]:
    for n, line in enumerate(open(f), 1):
        texts = re.findall(r"(?<![\w-])text-((?:ink-\d00|success|warning|danger|primary-ink))(?![\w-])", line)
        bgs = re.findall(r"(?<![\w-])bg-((?:surface|cream|sand|ink-50|primary|danger/\d+))(?![\w-])", line) or ["surface"]
        for t, b in itertools.product(set(texts), set(bgs)):
            for th in THEMES:
                r = ratio(color(th, t), color(th, b))
                if r < 4.5:
                    bad += 1; print(f"{f}:{n}: text-{t} sobre bg-{b} no tema {th}: {r:.2f}:1")
print(f"combinações abaixo de 4,5:1: {bad}")
sys.exit(1 if bad else 0)
