# Gera public/guia-socia.pdf (A5, 14 páginas) com a identidade da Sócia.
#
# Uso (na raiz do repositório):
#   pip install reportlab fonttools brotli pillow cairosvg
#   python3 scripts/guia/gerar_guia.py
#
# Fontes: public/fonts/noto-serif*.woff2 (as mesmas do app). Logotipo: public/brand/*.svg.
# Ilustração: public/illustrations/agenda-vazia-claro.webp. Telas: scripts/guia/telas/*.webp
# (capturas com dados de exemplo). Para mudar um texto, edite a página aqui e gere de novo.
import io
import os
import re
import tempfile

import cairosvg
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from PIL import Image
from reportlab.lib.colors import HexColor, Color
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont as RLFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph
from reportlab.lib.fonts import addMapping

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "public", "guia-socia.pdf")

W, H = 419.53, 595.28  # A5
M = 34  # margem

# Paleta (a mesma do app)
CREME = HexColor("#FAF6F1")
AREIA = HexColor("#F2EBE1")
LINHA = HexColor("#E6DDD2")
CACAU = HexColor("#3A2A22")
GRAFITE = HexColor("#2C2C2E")
MUTED = HexColor("#6E6862")
DOURADO = HexColor("#C9A876")
DOURADO_T = HexColor("#7E6338")  # dourado de texto (5,2:1 sobre o creme)
BRANCO = HexColor("#FFFFFF")
VERDE = HexColor("#5E8A63")

# ---- fontes: instâncias estáticas da Noto Serif a partir do woff2 do app --------------------
_tmp = tempfile.mkdtemp()


def _font(src, weight, name):
    f = TTFont(os.path.join(ROOT, "public", "fonts", src))
    f.flavor = None
    instancer.instantiateVariableFont(f, {"wght": weight}, inplace=True)
    for t in ("STAT", "HVAR", "MVAR"):
        if t in f:
            del f[t]
    # nome único por peso: sem isso, o PDF trata todas as instâncias como a mesma fonte
    for rec in f["name"].names:
        if rec.nameID in (1, 3, 4, 6, 16, 17):
            rec.string = name if rec.nameID != 6 else f"Socia{name.replace('-', '')}"
    path = os.path.join(_tmp, f"{name}.ttf")
    f.save(path)
    pdfmetrics.registerFont(RLFont(name, path))


_font("noto-serif.woff2", 400, "Serif")
_font("noto-serif.woff2", 500, "Serif-Medium")
_font("noto-serif.woff2", 600, "Serif-SemiBold")
_font("noto-serif-italic.woff2", 400, "Serif-Italic")
_font("noto-serif-italic.woff2", 500, "Serif-MediumItalic")
addMapping("Serif", 0, 0, "Serif")
addMapping("Serif", 1, 0, "Serif-SemiBold")
addMapping("Serif", 0, 1, "Serif-Italic")
addMapping("Serif", 1, 1, "Serif-MediumItalic")


# ---- imagens da marca ------------------------------------------------------------------------
def svg_png(name, color, height):
    s = open(os.path.join(ROOT, "public", "brand", name)).read()
    s = re.sub(r'fill="#[0-9A-Fa-f]{6}"', f'fill="{color}"', s)
    png = cairosvg.svg2png(bytestring=s.encode(), output_height=height)
    im = Image.open(io.BytesIO(png)).convert("RGBA")
    return im.crop(im.getchannel("A").getbbox())


def lockup(color, height=900):
    """S em cima e SÓCIA embaixo (mesma proporção do site)."""
    s = svg_png("socia-monograma.svg", color, height)
    w = svg_png("socia-wordmark.svg", color, round(height / 2.8))
    gap = round(w.height / 3)
    c = Image.new("RGBA", (max(s.width, w.width), s.height + gap + w.height), (0, 0, 0, 0))
    c.alpha_composite(s, ((c.width - s.width) // 2, 0))
    c.alpha_composite(w, ((c.width - w.width) // 2, s.height + gap))
    return c


_readers = {}


def reader(im):
    """Cada imagem entra uma vez só no PDF (o ReportLab reaproveita o mesmo leitor)."""
    key = id(im)
    if key not in _readers:
        b = io.BytesIO()
        if im.mode == "RGB":
            im.save(b, "JPEG", quality=86, optimize=True)
        else:
            im.save(b, "PNG", optimize=True)
        b.seek(0)
        _readers[key] = ImageReader(b)
    return _readers[key]


LOCKUP_DOURADO = lockup("#C9A876", 480)
ICON_DOURADO = svg_png("socia-monograma-pequeno.svg", "#C9A876", 120)
ICON_CACAU = svg_png("socia-monograma-pequeno.svg", "#3A2A22", 120)
ILUSTRA = Image.open(os.path.join(ROOT, "public", "illustrations", "agenda-vazia-claro.webp")).convert("RGB")
ILUSTRA.thumbnail((420, 420))
_telas = {}


def tela(nome):
    """Captura reduzida para ~320 dpi no tamanho em que aparece (118 pt de largura)."""
    if nome not in _telas:
        im = Image.open(os.path.join(HERE, "telas", f"{nome}.webp")).convert("RGB")
        im.thumbnail((540, 2000), Image.LANCZOS)
        _telas[nome] = im
    return _telas[nome]


# ---- estilos de texto ------------------------------------------------------------------------
BODY = ParagraphStyle("body", fontName="Serif", fontSize=8.4, leading=12.4, textColor=GRAFITE)
BODY_MUTED = ParagraphStyle("muted", parent=BODY, textColor=MUTED)
SMALL = ParagraphStyle("small", parent=BODY, fontSize=7.6, leading=11, textColor=MUTED)
ITEM_T = ParagraphStyle("itemt", parent=BODY, fontName="Serif-SemiBold", fontSize=8.8, leading=12)
LEAD = ParagraphStyle("lead", parent=BODY, fontSize=9.2, leading=13.6)


def para(c, text, x, y, width, style=BODY):
    """Desenha um parágrafo com o TOPO em y; devolve o y logo abaixo."""
    p = Paragraph(text, style)
    _, h = p.wrap(width, 1000)
    p.drawOn(c, x, y - h)
    return y - h


def kicker(c, text, y=H - M - 8, color=DOURADO_T):
    c.setFont("Serif-SemiBold", 6.6)
    c.setFillColor(color)
    c.drawString(M, y, " ".join(text.upper()))  # espaçamento de letras
    return y


def title(c, parts, y, size=19, color=GRAFITE, accent=DOURADO_T, width=W - 2 * M, x=M):
    """parts: lista de (texto, itálico?). Quebra por palavra; devolve o y da última linha."""
    words = []
    for t, it in parts:
        for w in t.split(" "):
            if w:
                words.append((w, it))
    lines, cur, cw = [], [], 0
    for w, it in words:
        fn = "Serif-MediumItalic" if it else "Serif-Medium"
        ww = pdfmetrics.stringWidth(w + " ", fn, size)
        if cur and cw + ww > width:
            lines.append(cur)
            cur, cw = [], 0
        cur.append((w, it))
        cw += ww
    if cur:
        lines.append(cur)
    lead = size * 1.18
    for i, line in enumerate(lines):
        xx = x
        yy = y - i * lead
        for w, it in line:
            fn = "Serif-MediumItalic" if it else "Serif-Medium"
            c.setFont(fn, size)
            c.setFillColor(accent if it else color)
            c.drawString(xx, yy, w)
            xx += pdfmetrics.stringWidth(w + " ", fn, size)
    return y - (len(lines) - 1) * lead


def footer(c, n, dark=False):
    c.drawImage(reader(ICON_DOURADO if dark else ICON_CACAU), M, 20, width=7.2, height=12, mask="auto")
    c.setFont("Serif", 7)
    c.setFillColor(DOURADO if dark else MUTED)
    c.drawRightString(W - M, 23, f"{n:02d}")


def bg(c, color):
    c.setFillColor(color)
    c.rect(0, 0, W, H, stroke=0, fill=1)


def card(c, x, y, w, h, fill=BRANCO, stroke=LINHA, r=8):
    """y = topo do cartão."""
    c.setFillColor(fill)
    if stroke is not None:
        c.setStrokeColor(stroke)
    c.setLineWidth(0.6)
    c.roundRect(x, y - h, w, h, r, stroke=1 if stroke else 0, fill=1)


def bullet(c, x, y, text, width, style=BODY, color=DOURADO):
    # estrelinha de 4 pontas (a mesma da ilustração)
    c.setFillColor(color)
    cx, cy, r = x + 2.6, y - 5.2, 2.6
    p = c.beginPath()
    p.moveTo(cx, cy + r)
    p.curveTo(cx + 0.4, cy + 0.4, cx + 0.4, cy + 0.4, cx + r, cy)
    p.curveTo(cx + 0.4, cy - 0.4, cx + 0.4, cy - 0.4, cx, cy - r)
    p.curveTo(cx - 0.4, cy - 0.4, cx - 0.4, cy - 0.4, cx - r, cy)
    p.curveTo(cx - 0.4, cy + 0.4, cx - 0.4, cy + 0.4, cx, cy + r)
    c.drawPath(p, stroke=0, fill=1)
    return para(c, text, x + 11, y, width - 11, style)


def phone(c, x, y, w, im):
    """Moldura de celular; y = topo. Devolve a altura."""
    sw = w - 6
    sh = sw * im.height / im.width
    h = sh + 6
    c.setFillColor(GRAFITE)
    c.roundRect(x, y - h, w, h, 13, stroke=0, fill=1)
    c.saveState()
    pth = c.beginPath()
    pth.roundRect(x + 3, y - h + 3, sw, sh, 10.5)
    c.clipPath(pth, stroke=0, fill=0)
    c.drawImage(reader(im), x + 3, y - h + 3, width=sw, height=sh)
    c.restoreState()
    return h


def circle_illustration(c, cx, cy, r):
    c.saveState()
    pth = c.beginPath()
    pth.circle(cx, cy, r)
    c.clipPath(pth, stroke=0, fill=0)
    s = r * 2 / 0.62  # a ilustração tem margem branca em volta do círculo
    c.drawImage(reader(ILUSTRA), cx - s / 2, cy - s / 2, width=s, height=s)
    c.restoreState()


# =============================================================================================
def p_capa(c):
    bg(c, CACAU)
    c.setStrokeColor(Color(0.79, 0.66, 0.46, alpha=0.35))
    c.setLineWidth(0.7)
    c.circle(W + 10, H - 30, 150, stroke=1, fill=0)
    lw = 120
    lh = lw * LOCKUP_DOURADO.height / LOCKUP_DOURADO.width
    c.drawImage(reader(LOCKUP_DOURADO), M, H - 90 - lh, width=lw, height=lh, mask="auto")
    c.setFillColor(CREME)
    c.setFont("Serif-Medium", 34)
    c.drawString(M, 230, "Guia de uso")
    c.setStrokeColor(DOURADO)
    c.setLineWidth(1)
    c.line(M, 214, M + 34, 214)
    para(c, "Tudo o que você precisa para começar e deixar a rotina do seu negócio em ordem.", M, 202, 250,
         ParagraphStyle("cs", parent=LEAD, textColor=HexColor("#E9DFD3")))
    c.setFont("Serif", 6.8)
    c.setFillColor(HexColor("#CDBFAF"))
    c.drawString(M, 30, "Para profissionais de beleza · Versão de novembro de 2026")


TOC = [
    ("Primeiro acesso", 3), ("Sua primeira semana", 4), ("Início e previsão de faturamento", 5), ("Agenda", 6),
    ("Atendimento, passo a passo", 7), ("Editar um atendimento", 8), ("Clientes", 9), ("WhatsApp", 10),
    ("Financeiro", 11), ("Relatórios e configurações", 12), ("Assinatura e suporte", 13),
]


def p_boas_vindas(c):
    bg(c, CREME)
    kicker(c, "Boas-vindas")
    y = title(c, [("Que bom ter você", False), ("aqui.", True)], H - M - 34, width=230)
    circle_illustration(c, W - M - 42, H - M - 40, 40)
    y = para(c, "A Sócia reúne agenda, clientes, financeiro e mensagens automáticas no WhatsApp num só lugar. "
                "Este guia mostra o caminho mais curto para tudo funcionar já na primeira semana.",
             M, y - 16, 250, LEAD)
    kicker(c, "Neste guia", y - 30)
    yy = y - 46
    for name, n in TOC:
        c.setFont("Serif", 9)
        c.setFillColor(GRAFITE)
        c.drawString(M, yy, name)
        c.setFillColor(DOURADO_T)
        c.drawRightString(W - M, yy, f"{n:02d}")
        c.setStrokeColor(LINHA)
        c.setLineWidth(0.5)
        c.line(M, yy - 6, W - M, yy - 6)
        yy -= 21
    footer(c, 2)


def p_primeiro_acesso(c):
    bg(c, CREME)
    kicker(c, "Primeiro acesso")
    y = title(c, [("Entre na Sócia em", False), ("poucos minutos.", True)], H - M - 34)
    y -= 24
    steps = [
        ("Crie sua senha", "Logo depois da assinatura, chega um e-mail no endereço que você usou no Mercado Pago. "
                           "Toque no link e crie sua senha. Não chegou? Confira a caixa de spam."),
        ("Entre no app", "Acesse <b>hive-beauty.vercel.app</b> e entre com o seu e-mail e a senha que você criou."),
        ("Deixe na tela inicial", "Assim a Sócia abre como um aplicativo, com um toque. Não precisa instalar nada na loja."),
    ]
    for i, (t, d) in enumerate(steps, 1):
        c.setFont("Serif-Medium", 18)
        c.setFillColor(DOURADO_T)
        c.drawString(M, y - 16, f"{i:02d}")
        yy = para(c, t, M + 40, y - 3, W - 2 * M - 40, ITEM_T)
        yy = para(c, d, M + 40, yy - 2, W - 2 * M - 40, BODY_MUTED)
        y = yy - 18
    bw = (W - 2 * M - 10) / 2
    for i, (t, d) in enumerate([
        ("No Android (Chrome)", "Toque nos três pontos no canto da tela e depois em <b>Adicionar à tela inicial</b> (ou <b>Instalar app</b>)."),
        ("No iPhone (Safari)", "Toque no botão de compartilhar e depois em <b>Adicionar à Tela de Início</b>."),
    ]):
        x = M + i * (bw + 10)
        card(c, x, y, bw, 92)
        yy = para(c, t, x + 12, y - 12, bw - 24, ITEM_T)
        para(c, d, x + 12, yy - 4, bw - 24, BODY_MUTED)
    footer(c, 3)


def p_primeira_semana(c):
    bg(c, CREME)
    kicker(c, "Sua primeira semana")
    y = title(c, [("Cinco passos para a Sócia", False), ("trabalhar por você.", True)], H - M - 34)
    y = para(c, "Faça nesta ordem. Leva menos de uma hora, e depois disso o dia a dia fica no automático.",
             M, y - 14, W - 2 * M, BODY_MUTED) - 14
    items = [
        ("Cadastre seus serviços", "<b>Mais › Serviços</b>: nome, duração e valor de cada um."),
        ("Ajuste seu horário", "<b>Mais › Configurações › Horário de funcionamento</b>."),
        ("Traga suas clientes", "<b>Clientes ›</b> ícone de importar: use os contatos do celular (.vcf) ou uma planilha (.csv)."),
        ("Conecte o WhatsApp", "<b>Mais › Configurações › WhatsApp › Conectar WhatsApp</b> (passo a passo na página 10)."),
        ("Marque o primeiro atendimento", "<b>Início › Novo atendimento</b>. A confirmação já sai pelo WhatsApp."),
    ]
    for t, d in items:
        h = 50
        card(c, M, y, W - 2 * M, h)
        c.setStrokeColor(DOURADO)
        c.setLineWidth(0.9)
        c.roundRect(M + 12, y - 30, 11, 11, 2.5, stroke=1, fill=0)
        yy = para(c, t, M + 32, y - 11, W - 2 * M - 44, ITEM_T)
        para(c, d, M + 32, yy - 1, W - 2 * M - 44, SMALL)
        y -= h + 8
    footer(c, 4)


def money_row(c, x, y, w, label, sub, value):
    c.setFont("Serif-Medium", 8.2)
    c.setFillColor(GRAFITE)
    c.drawString(x, y, label)
    c.setFont("Serif", 6.4)
    c.setFillColor(MUTED)
    c.drawString(x, y - 9, sub)
    c.setFont("Serif-Medium", 10.5)
    c.setFillColor(DOURADO_T)
    c.drawRightString(x + w, y - 3, value)


def p_inicio(c):
    bg(c, CREME)
    kicker(c, "Início e previsão de faturamento")
    y = title(c, [("Seu negócio", False), ("de relance.", True)], H - M - 34)
    y = para(c, "O Início mostra o dia de hoje e quanto deve entrar no dia, na semana e no mês, "
                "a partir do que já foi atendido e do que está agendado.", M, y - 14, W - 2 * M, BODY_MUTED) - 16
    # cartão "Hoje" (exemplo)
    cw = W - 2 * M
    card(c, M, y, cw, 70, fill=CACAU, stroke=None, r=10)
    c.setFont("Serif-SemiBold", 7.6)
    c.setFillColor(CREME)
    c.drawString(M + 14, y - 16, "Hoje")
    c.setFont("Serif-Medium", 18)
    c.setFillColor(DOURADO)
    c.drawString(M + 14, y - 41, "R$ 380,00")
    c.setFont("Serif", 6.4)
    c.setFillColor(HexColor("#D9CCBD"))
    c.drawString(M + 14, y - 53, "Recebido hoje")
    for i, (v, l) in enumerate([("4", "Atendimentos hoje"), ("11", "Próximos 7 dias")]):
        xx = M + 170 + i * 90
        c.setFont("Serif-Medium", 14)
        c.setFillColor(CREME)
        c.drawString(xx, y - 41, v)
        c.setFont("Serif", 6.4)
        c.setFillColor(HexColor("#D9CCBD"))
        c.drawString(xx, y - 53, l)
    y -= 80
    # cartão "Previsão de faturamento" (exemplo)
    card(c, M, y, cw, 96, r=10)
    c.setFont("Serif-SemiBold", 7.6)
    c.setFillColor(GRAFITE)
    c.drawString(M + 14, y - 16, "Previsão de faturamento")
    rows = [("Hoje", "R$ 380,00 realizado · R$ 150,00 agendado", "R$ 530,00"),
            ("Esta semana", "R$ 1.020,00 realizado · R$ 940,00 agendado", "R$ 1.960,00"),
            ("Este mês", "R$ 2.650,00 realizado · R$ 3.180,00 agendado", "R$ 5.830,00")]
    for i, (l, sub, v) in enumerate(rows):
        money_row(c, M + 14, y - 34 - i * 22, cw - 28, l, sub, v)
    c.setFont("Serif-Italic", 6.2)
    c.setFillColor(MUTED)
    c.drawString(M, y - 106, "Valores de exemplo.")
    y -= 124
    for t in [
        "<b>Hoje</b>: quanto já entrou, quantos atendimentos tem no dia e quantos estão marcados para os próximos 7 dias.",
        "<b>Previsão de faturamento</b>: para hoje, esta semana e este mês, soma o que já foi atendido (realizado) "
        "com o que está agendado. Cancelamentos e faltas ficam de fora.",
        "A previsão muda sozinha: cada atendimento marcado, remarcado ou cancelado já entra na conta.",
        "No Financeiro, a previsão acompanha o período que você escolher, inclusive um período personalizado.",
        "Só a administração do negócio vê os valores.",
    ]:
        y = bullet(c, M, y, t, W - 2 * M) - 9
    footer(c, 5)


def p_agenda(c):
    bg(c, CREME)
    kicker(c, "Agenda")
    tw = 220
    y = title(c, [("Seu dia, sua semana,", False), ("seu mês.", True)], H - M - 34, width=tw)
    y = para(c, "Alterne entre <b>Dia</b>, <b>Semana</b> e <b>Mês</b> no topo da Agenda. No mês, os pontos mostram "
                "os dias com atendimento: dourado para em aberto e verde para concluído.", M, y - 14, tw, BODY_MUTED)
    kicker(c, "Novo atendimento", y - 24)
    y -= 40
    for t in [
        "Toque em <b>Novo atendimento</b> no Início ou em <b>Novo</b> na Agenda.",
        "Escolha a cliente, o serviço e a profissional. A duração e o valor vêm do serviço e podem ser ajustados.",
        "Mais de um serviço? Adicione no mesmo atendimento: valor e duração somam sozinhos.",
        "Escolha um horário livre e salve. Se o WhatsApp estiver conectado, a cliente recebe a confirmação.",
    ]:
        y = bullet(c, M, y, t, tw) - 8
    y -= 6
    card(c, M, y, tw, 74, fill=AREIA, stroke=None)
    yy = para(c, "Atendimento que já aconteceu", M + 12, y - 11, tw - 24, ITEM_T)
    para(c, "Ligue <b>Atendimento que já aconteceu</b> no novo atendimento e informe o dia e o horário. "
            "Ele entra como concluído e vai para o Financeiro na data certa.", M + 12, yy - 2, tw - 24, SMALL)
    phone(c, W - M - 118, H - M - 30, 118, tela("agenda-semana"))
    c.setFont("Serif-Italic", 6.2)
    c.setFillColor(MUTED)
    c.drawRightString(W - M, 52, "Telas com dados de exemplo.")
    footer(c, 6)


def p_atendimento(c):
    bg(c, GRAFITE)
    kicker(c, "Atendimento, passo a passo", color=DOURADO)
    y = title(c, [("Do agendamento", False), ("ao recebimento.", True)], H - M - 34, color=CREME, accent=DOURADO)
    y = para(c, "Abra o atendimento na Agenda para registrar cada etapa. O Financeiro é atualizado sozinho.",
             M, y - 14, W - 2 * M, ParagraphStyle("d1", parent=BODY, textColor=HexColor("#CFC8C0"))) - 18
    st = ParagraphStyle("d2", parent=BODY, textColor=HexColor("#CFC8C0"))
    tt = ParagraphStyle("d3", parent=ITEM_T, textColor=CREME)
    steps = [
        ("Agendado", "O horário fica reservado. Com o WhatsApp conectado, a cliente recebe a confirmação e, na véspera, às 8h, um lembrete."),
        ("Atendimento realizado", "A partir do horário marcado, registre o atendimento: confira o valor final e a forma de pagamento "
                                  "(o Pix já vem marcado). Se ela ainda não pagou, ligue <b>Recebimento pendente</b>."),
        ("Esqueceu de registrar?", "Cinco minutos depois do horário de término, a Sócia conclui sozinha, como recebido no Pix. "
                                   "Dá para corrigir depois: trocar a forma, marcar como pendente ou editar."),
        ("Cliente não compareceu", "Registra a falta e tira o valor do Financeiro. Ela aparece nos relatórios."),
        ("Cancelar agendamento", "Libera o horário. Se ela já tinha recebido a confirmação, recebe também o aviso de cancelamento pelo WhatsApp."),
    ]
    x = M + 14
    top = y
    for i, (t, d) in enumerate(steps):
        c.setFillColor(DOURADO)
        c.circle(M + 3, y - 5, 3, stroke=0, fill=1)
        yy = para(c, t, x, y, W - 2 * M - 14, tt)
        yy = para(c, d, x, yy - 2, W - 2 * M - 14, st)
        last = y
        y = yy - 16
    c.setStrokeColor(Color(0.79, 0.66, 0.46, alpha=0.45))
    c.setLineWidth(0.7)
    c.line(M + 3, top - 8, M + 3, last - 2)
    para(c, "Quem registra é a profissional responsável pelo atendimento ou a administração do negócio.",
         M, y - 4, W - 2 * M, ParagraphStyle("d4", parent=SMALL, textColor=HexColor("#A9A19A")))
    footer(c, 7, dark=True)


def p_editar(c):
    bg(c, CREME)
    kicker(c, "Editar um atendimento")
    y = title(c, [("Mudou alguma coisa?", False), ("É só editar.", True)], H - M - 34)
    y = para(c, "Abra o atendimento na Agenda e toque em <b>Editar</b>. Dá para trocar a cliente, o serviço, a duração, "
                "o horário e o valor, antes ou depois do atendimento.", M, y - 14, W - 2 * M, BODY_MUTED) - 16
    blocks = [
        ("Antes do atendimento", "Editar agendamento", [
            "Cliente, serviço, profissional, dia, horário, duração, valor e serviços adicionais.",
            "Mudou a duração? O horário atual continua disponível.",
            "Precisa de um horário fora da grade? Toque em <b>Outro horário</b> e digite.",
            "Mudou o dia, o horário ou o serviço? Se ela já tinha recebido a confirmação, recebe o aviso de remarcação.",
        ]),
        ("Depois do atendimento", "Editar atendimento", [
            "Cliente, serviço, dia, horário, duração, valor e recebimento, para corrigir um lançamento.",
            "O Financeiro acompanha a mudança, inclusive a data do recebimento.",
            "Nenhuma mensagem é enviada para a cliente.",
            "Só a administração do negócio edita um atendimento concluído.",
        ]),
    ]
    for head, btn, items in blocks:
        h = 128
        card(c, M, y, W - 2 * M, h)
        c.setFont("Serif-SemiBold", 9)
        c.setFillColor(GRAFITE)
        c.drawString(M + 12, y - 18, head)
        c.setFont("Serif-Italic", 7.4)
        c.setFillColor(DOURADO_T)
        c.drawRightString(W - M - 12, y - 18, f"botão: {btn}")
        yy = y - 28
        for t in items:
            yy = bullet(c, M + 12, yy, t, W - 2 * M - 24, SMALL) - 5
        y -= h + 10
    card(c, M, y, W - 2 * M, 44, fill=AREIA, stroke=None)
    para(c, "<b>Bateu com outro atendimento?</b> A Sócia avisa e não deixa salvar dois atendimentos no mesmo horário. "
            "Confira a duração ou escolha outro horário.", M + 12, y - 10, W - 2 * M - 24, SMALL)
    footer(c, 8)


def p_clientes(c):
    bg(c, CREME)
    tx = M + 132
    tw = W - M - tx
    kicker(c, "Clientes")
    c.saveState()
    y = title(c, [("Cada cliente, com o", False), ("histórico à mão.", True)], H - M - 34, x=tx, width=tw)
    c.restoreState()
    phone(c, M, H - M - 30, 118, tela("clientes"))
    y -= 18
    for t in [
        "<b>Importe de uma vez</b> os contatos do celular (.vcf) ou uma planilha (.csv). A tela de importação explica como exportar.",
        "<b>Na ficha</b>: telefone, aniversário, observações, histórico de atendimentos e próximos horários.",
        "<b>Enviar para a cliente</b> manda, pelo WhatsApp, todos os horários marcados dela.",
        "<b>Filtros</b>: clientes novas, recorrentes e as que não aparecem há um tempo.",
        "<b>Central de comunicação</b> (ícone de mensagem): uma mensagem para várias clientes de uma vez, "
        "só para quem autorizou receber. Quem responde SAIR deixa de receber.",
    ]:
        y = bullet(c, tx, y, t, tw) - 8
    c.setFont("Serif-Italic", 6.2)
    c.setFillColor(MUTED)
    c.drawString(M, 52, "Telas com dados de exemplo.")
    footer(c, 9)


def p_whatsapp(c):
    bg(c, CREME)
    kicker(c, "WhatsApp")
    y = title(c, [("As mensagens saem", False), ("pelo seu número.", True)], H - M - 34)
    y -= 14
    card(c, M, y, W - 2 * M, 104, fill=AREIA, stroke=None)
    yy = para(c, "Para conectar", M + 12, y - 11, W - 2 * M - 24, ITEM_T) - 4
    for i, t in enumerate([
        "Na Sócia: <b>Mais › Configurações › WhatsApp › Conectar WhatsApp</b>. Aparece um QR Code.",
        "No celular da empresa, abra o WhatsApp e toque em <b>Configurações</b> (ou nos três pontos) › "
        "<b>Aparelhos conectados</b> › <b>Conectar um aparelho</b>.",
        "Aponte a câmera para o QR Code. Pronto: aparece <b>Conectado</b>.",
    ], 1):
        c.setFont("Serif-SemiBold", 8)
        c.setFillColor(DOURADO_T)
        c.drawString(M + 12, yy - 9, str(i))
        yy = para(c, t, M + 24, yy, W - 2 * M - 36, SMALL) - 4
    y -= 118
    kicker(c, "O que sai sozinho", y)
    y -= 14
    for t in [
        "<b>Ao agendar</b>: confirmação do horário, com as mensagens da Sócia ou com o seu texto.",
        "<b>Na véspera, às 8h</b>: lembrete do atendimento.",
        "<b>Se algo mudar</b>: aviso de remarcação ou de cancelamento.",
        "<b>Aniversário e datas especiais</b> (Ano-Novo, Dia da Mulher, Dia do Autocuidado, Dia do Cliente, Natal e "
        "o aniversário de cliente da casa): às 9h do dia, só para quem autorizou. Cada uma você liga quando quiser.",
    ]:
        y = bullet(c, M, y, t, W - 2 * M, SMALL) - 6
    y = para(c, "<b>Cuidados</b>: mantenha o celular da empresa com internet e envie só para as suas clientes. "
                "O WhatsApp tem regras próprias e pode restringir números que considere em desacordo com elas.",
             M, y - 4, W - 2 * M, SMALL) - 14
    card(c, M, y, W - 2 * M, 78, fill=BRANCO)
    circle_illustration(c, W - M - 40, y - 39, 28)
    c.setFont("Serif-SemiBold", 6.6)
    c.setFillColor(DOURADO_T)
    c.drawString(M + 12, y - 16, " ".join("DICA"))
    para(c, "Use um número só para o negócio. As conversas pessoais ficam separadas e as suas clientes sempre "
            "sabem com quem estão falando.", M + 12, y - 24, W - 2 * M - 94,
         ParagraphStyle("tip", parent=BODY, fontName="Serif-Medium", fontSize=8.6, leading=12))
    footer(c, 10)


def p_financeiro(c):
    bg(c, CREME)
    tw = 222
    kicker(c, "Financeiro")
    y = title(c, [("O que entrou, o que falta", False), ("e o que vem por aí.", True)], H - M - 34, width=tw)
    y -= 18
    for t in [
        "<b>Previsão de faturamento</b>: o realizado somado ao agendado no período escolhido.",
        "<b>Faturamento</b> é o que foi cobrado; <b>recebido</b> é o que já entrou; <b>pendente</b> é o que falta receber.",
        "Os atendimentos concluídos entram aqui sozinhos.",
        "Use <b>+ Recebimento</b> para lançar um valor avulso.",
        "Registre os gastos em <b>Despesas</b> e veja o resultado do período: recebido menos despesas.",
        "Escolha o período no topo: hoje, esta semana, este mês, o mês anterior ou um período personalizado.",
    ]:
        y = bullet(c, M, y, t, tw) - 8
    phone(c, W - M - 118, H - M - 30, 118, tela("financeiro"))
    c.setFont("Serif-Italic", 6.2)
    c.setFillColor(MUTED)
    c.drawString(M, 52, "Telas com dados de exemplo.")
    footer(c, 11)


def p_relatorios(c):
    bg(c, CREME)
    tx = M + 132
    tw = W - M - tx
    phone(c, M, H - M - 30, 118, tela("relatorios"))
    c.setFont("Serif-SemiBold", 6.6)
    c.setFillColor(DOURADO_T)
    c.drawString(tx, H - M - 8, " ".join("RELATÓRIOS"))
    y = title(c, [("Decida com", False), ("números.", True)], H - M - 34, x=tx, width=tw)
    para(c, "Em <b>Mais › Relatórios</b>: atendimentos, faturamento, recebido, despesas, cancelamentos, faltas, "
            "clientes novas e recorrentes, os serviços mais feitos, os que mais faturam (inclusive por hora de agenda) "
            "e as clientes que mais gastam.", tx, y - 14, tw, BODY_MUTED)
    y = 250
    kicker(c, "Configurações", y)
    y -= 14
    for t in [
        "<b>Aparência</b>: tema claro, escuro ou automático (segue o celular).",
        "<b>Como você quer ser chamada</b>: o nome da saudação e da assinatura das mensagens.",
        "<b>WhatsApp</b>: conexão e mensagens automáticas.",
        "<b>Nome da empresa</b> e <b>horário de funcionamento</b>: os horários em que você atende.",
        "<b>Equipe</b>: a função de cada pessoa (Administradora, Profissional ou Recepção) e o acesso de quem saiu. "
        "Para incluir alguém, fale com o nosso suporte.",
    ]:
        y = bullet(c, M, y, t, W - 2 * M, SMALL) - 6
    footer(c, 12)


def p_assinatura(c):
    bg(c, CREME)
    kicker(c, "Assinatura e suporte")
    y = title(c, [("Sem surpresa, e", False), ("com quem falar.", True)], H - M - 34) - 20
    for q, a in [
        ("Quando sou cobrada?", "Os 7 primeiros dias são grátis. Depois, R$ 59,90 por mês, cobrados pelo Mercado Pago na forma "
                                "de pagamento que você cadastrou. Dois dias antes da primeira cobrança, avisamos por e-mail."),
        ("Como cancelo?", "Quando quiser, sem multa, em Assinaturas no Mercado Pago, ou pelo nosso e-mail. Se cancelar depois "
                          "de pagar, o acesso continua até o fim do período já pago."),
        ("E os meus dados?", "Os dados das suas clientes são seus. Depois que o acesso termina, ficam guardados por 90 dias "
                             "para você poder voltar. Detalhes na Política de Privacidade."),
    ]:
        y = para(c, q, M, y, W - 2 * M, ParagraphStyle("q", parent=ITEM_T, textColor=DOURADO_T))
        y = para(c, a, M, y - 3, W - 2 * M, BODY) - 10
        c.setStrokeColor(LINHA)
        c.setLineWidth(0.5)
        c.line(M, y + 2, W - M, y + 2)
        y -= 12
    y -= 6
    card(c, M, y, W - 2 * M, 72, fill=AREIA, stroke=None)
    yy = para(c, "Fale com a gente", M + 14, y - 12, W - 2 * M - 28, ITEM_T)
    para(c, "WhatsApp: (31) 99919-1534<br/>E-mail: hivebeauty.suporte@gmail.com<br/>Atendimento em dias úteis.",
         M + 14, yy - 3, W - 2 * M - 28, BODY_MUTED)
    footer(c, 13)


def p_contracapa(c):
    bg(c, CACAU)
    c.drawImage(reader(ICON_DOURADO), M, H - 150, width=9, height=15, mask="auto")
    title(c, [("Você cuida das clientes.", False), ("A Sócia cuida da rotina.", True)], H - 182, size=20,
          color=CREME, accent=DOURADO, width=W - 2 * M - 40)
    lw = 96
    lh = lw * LOCKUP_DOURADO.height / LOCKUP_DOURADO.width
    c.drawImage(reader(LOCKUP_DOURADO), W - M - lw, 54, width=lw, height=lh, mask="auto")
    c.setFont("Serif", 7.4)
    c.setFillColor(HexColor("#CDBFAF"))
    c.drawString(M, 60, "socia-beauty.lovable.app")
    c.drawString(M, 48, "hive-beauty.vercel.app")


PAGES = [p_capa, p_boas_vindas, p_primeiro_acesso, p_primeira_semana, p_inicio, p_agenda, p_atendimento,
         p_editar, p_clientes, p_whatsapp, p_financeiro, p_relatorios, p_assinatura, p_contracapa]


def main():
    c = canvas.Canvas(OUT, pagesize=(W, H))
    c.setTitle("Guia de uso da Sócia")
    c.setAuthor("Sócia")
    c.setSubject("Guia de uso para profissionais de beleza")
    for fn in PAGES:
        fn(c)
        c.showPage()
    c.save()
    print(OUT)


if __name__ == "__main__":
    main()
