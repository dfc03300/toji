import json
import re
import sys
import urllib.parse
import urllib.request
from copy import copy
from datetime import datetime
from pathlib import Path

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
from openpyxl.utils import get_column_letter


HEADERS = [
    "기호",
    "소재지",
    "지번",
    "시점",
    "면적",
    "지목",
    "용도지역",
    "이용상황",
    "도로교통",
    "형상",
    "지세",
    "목적/거래가격",
    "단가(원/㎡)",
    "개별공시지가",
    "개공비율",
    "검토",
    "시점수정치",
    "시점수정",
    "크롤링상태",
]

SIDO_CACHE = {}
SIGUNGU_CACHE = {}
DONGRI_CACHE = {}


def log(message):
    print(message, flush=True)


def norm(value):
    return str(value or "").strip()


def to_number(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    text = re.sub(r"[^0-9.\-]", "", str(value))
    if not text:
        return None
    try:
        return float(text) if "." in text else int(text)
    except ValueError:
        return None


def split_jibun(value):
    text = norm(value)
    san = "1"
    if text.startswith("산"):
        san = "2"
        text = text[1:].strip()
    main, sub = (text.split("-", 1) + ["0"])[:2] if "-" in text else (text, "0")
    main_digits = re.sub(r"\D", "", str(main))
    sub_digits = re.sub(r"\D", "", str(sub))
    if not main_digits:
        return san, "", ""
    return san, main_digits.zfill(4), (sub_digits or "0").zfill(4)


def post_json(path, params):
    data = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(
        f"https://www.realtyprice.kr{path}",
        data=data,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=12) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_list(path, params):
    data = post_json(path, params)
    return data.get("model", {}).get("list", []) or []


def code_lookup(si_gun_gu, dong):
    parts = si_gun_gu.split()
    if len(parts) < 2:
        return None
    sido_name = parts[0]
    sigungu_name = parts[1]
    dong_name = dong.strip()

    if "sido" not in SIDO_CACHE:
        SIDO_CACHE["sido"] = get_list("/notice/m/bjd/getSido.do", {"notice_year": ""})
    sido = next((x for x in SIDO_CACHE["sido"] if x.get("NAME") == sido_name), None)
    if not sido:
        return None

    sig_key = sido["CODE"]
    if sig_key not in SIGUNGU_CACHE:
        SIGUNGU_CACHE[sig_key] = get_list("/notice/m/bjd/getSigungu.do", {"notice_year": "", "reg1": sig_key})
    sigungu = next((x for x in SIGUNGU_CACHE[sig_key] if x.get("NAME") == sigungu_name), None)
    if not sigungu:
        return None

    dong_key = sigungu["CODE"]
    if dong_key not in DONGRI_CACHE:
        DONGRI_CACHE[dong_key] = get_list("/notice/m/bjd/getDongri.do", {"notice_year": "", "reg": dong_key})
    dongri = next((x for x in DONGRI_CACHE[dong_key] if x.get("NAME") == dong_name), None)
    if not dongri:
        return None

    return sido, sigungu, dongri


def crawl_price(si_gun_gu, dong, jibun, trade_date):
    codes = code_lookup(norm(si_gun_gu), norm(dong))
    if not codes:
        return None, "주소코드 미확인"

    sido, sigungu, dongri = codes
    san, bun1, bun2 = split_jibun(jibun)
    if not bun1:
        return None, "지번 파싱 실패"

    rows = get_list(
        "/notice/m/gsi/getList.do",
        {
            "search_detail_gbn": "2",
            "notice_year": "",
            "notice_year_nm": "",
            "sido": sido["CODE"],
            "sido_nm": sido["NAME"],
            "sigungu": sigungu["CODE"],
            "sigungu_nm": sigungu["NAME"],
            "road_reg": sigungu["CODE"],
            "road_initial": "",
            "road_initial_nm": "",
            "road_code": "",
            "road_code_nm": "",
            "dongri": dongri["CODE"],
            "dongri_nm": dongri["NAME"],
            "reg": sigungu["CODE"],
            "eub": dongri["CODE"],
            "san": san,
            "bun1": bun1,
            "bun2": bun2,
            "build_bun1": "",
            "build_bun2": "00000",
        },
    )
    if not rows:
        return None, "조회결과 없음"

    trade_year = trade_date.year if isinstance(trade_date, datetime) else None
    chosen = None
    if trade_year:
        chosen = next((row for row in rows if str(row.get("base_year")) == str(trade_year)), None)
    chosen = chosen or rows[0]
    price = to_number(chosen.get("gakuka_w"))
    return {
        "price": price,
        "base_year": chosen.get("base_year"),
        "notice_ymd": chosen.get("notice_ymd"),
        "address": chosen.get("addr"),
        "rows": len(rows),
    }, "조회완료"


def abbreviation(zone):
    text = norm(zone)
    mapping = {
        "제1종일반주거지역": "1주",
        "제2종일반주거지역": "2주",
        "제3종일반주거지역": "3주",
        "준주거지역": "준주거",
        "일반상업지역": "상업",
        "근린상업지역": "근상",
    }
    return mapping.get(text, text)


def find_land_row(ws, row):
    if norm(ws.cell(row, 6).value) == "토지":
        return row
    jibun = norm(ws.cell(row, 5).value)
    for candidate in range(row + 1, min(ws.max_row, row + 5) + 1):
        if norm(ws.cell(candidate, 6).value) == "토지":
            if not jibun or norm(ws.cell(candidate, 5).value) == jibun:
                return candidate
            return candidate
    return row


def selected_rows(ws):
    rows = []
    for row in range(5, ws.max_row + 1):
        value = ws.cell(row, 1).value
        if isinstance(value, int):
            rows.append(row)
    return rows


def classify_review(ws, row):
    detail = norm(ws.cell(row, 6).value)
    memo = " ".join(norm(ws.cell(row, col).value) for col in (15, 18))
    if detail == "토지" or "토지만" in memo:
        return "토지만"
    if "철거" in memo:
        return "토지만"
    if "화체" in memo:
        return "토지건물"
    return "토지건물" if detail in ("건물", "") else ""


def copy_widths(src, dst):
    widths = [8, 14, 12, 12, 10, 8, 12, 12, 12, 10, 9, 16, 14, 14, 10, 10, 12, 10, 18]
    for idx, width in enumerate(widths, start=1):
        dst.column_dimensions[get_column_letter(idx)].width = width


def strip_excel_repair_triggers(wb):
    """Remove legacy drawing/external-link parts that Excel repairs after openpyxl save."""
    if hasattr(wb, "_external_links"):
        wb._external_links = []
    for sheet in wb.worksheets:
        if hasattr(sheet, "_images"):
            sheet._images = []
        if hasattr(sheet, "_charts"):
            sheet._charts = []
        if hasattr(sheet, "legacy_drawing"):
            sheet.legacy_drawing = None


def freeze_external_formulas(wb, wb_values):
    """Replace formulas that point to missing external workbooks with cached values."""
    value_sheets = {sheet.title: sheet for sheet in wb_values.worksheets}
    for sheet in wb.worksheets:
        value_sheet = value_sheets.get(sheet.title)
        if not value_sheet:
            continue
        for row in sheet.iter_rows():
            for cell in row:
                value = cell.value
                if isinstance(value, str) and value.startswith("=") and ("[" in value or "]" in value):
                    cell.value = value_sheet[cell.coordinate].value


def build(input_path, output_path, summary_path):
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(summary_path).parent.mkdir(parents=True, exist_ok=True)
    log("원본 엑셀을 읽는 중입니다.")
    wb_values = openpyxl.load_workbook(input_path, data_only=True)
    src_values = wb_values.worksheets[0]
    wb = openpyxl.load_workbook(input_path)
    strip_excel_repair_triggers(wb)
    freeze_external_formulas(wb, wb_values)
    if "자동정리" in wb.sheetnames:
        del wb["자동정리"]
    ws = wb.create_sheet("자동정리")

    title_fill = PatternFill("solid", fgColor="12343B")
    head_fill = PatternFill("solid", fgColor="D9E8E6")
    thin = Side(style="thin", color="C9D4D1")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    ws["A1"] = "토지 거래 자동 정리"
    ws["A1"].font = Font(size=15, bold=True, color="FFFFFF")
    ws["A1"].fill = title_fill
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(HEADERS))
    ws["A2"] = "원본 탭 기준 자동 추출 + realtyprice.kr 개별공시지가 조회 보강"
    ws["A2"].font = Font(color="5C6B70")
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=len(HEADERS))

    for col, header in enumerate(HEADERS, 1):
        cell = ws.cell(4, col, header)
        cell.fill = head_fill
        cell.font = Font(bold=True)
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = border
    copy_widths(src_values, ws)
    ws.freeze_panes = "A5"

    preview = []
    warnings = []
    rows = selected_rows(src_values)
    log(f"선택 사례 {len(rows)}건을 정리하는 중입니다.")

    for idx, row in enumerate(rows, start=1):
        land_row = find_land_row(src_values, row)
        source_no = src_values.cell(row, 1).value
        si_gun_gu = src_values.cell(row, 3).value
        dong = src_values.cell(row, 4).value
        jibun = src_values.cell(row, 5).value
        trade_date = src_values.cell(row, 9).value
        land_area = src_values.cell(land_row, 10).value
        official_price = src_values.cell(row, 26).value
        crawl_status = "원본 공시지가 사용"

        crawled = None
        if official_price in (None, ""):
            try:
                log(f"{idx}/{len(rows)} {norm(dong)} {norm(jibun)} 공시지가 조회 중입니다.")
                crawled, crawl_status = crawl_price(si_gun_gu, dong, jibun, trade_date)
                if crawled and crawled.get("price"):
                    official_price = crawled["price"]
            except Exception as exc:
                crawl_status = f"조회실패: {exc}"
                warnings.append(f"{norm(dong)} {norm(jibun)} - {crawl_status}")
        else:
            try:
                log(f"{idx}/{len(rows)} {norm(dong)} {norm(jibun)} 공시지가 검증 조회 중입니다.")
                crawled, status = crawl_price(si_gun_gu, dong, jibun, trade_date)
                if crawled and crawled.get("price"):
                    crawl_status = f"조회완료 {crawled.get('base_year')}년 {crawled.get('price'):,}"
                else:
                    crawl_status = status
            except Exception as exc:
                crawl_status = f"원본 유지, 조회실패: {exc}"

        unit_price = src_values.cell(row, 16).value
        public_ratio = src_values.cell(row, 27).value
        if public_ratio in (None, "") and unit_price not in (None, "") and official_price:
            try:
                public_ratio = unit_price / official_price
            except Exception:
                public_ratio = None

        record = [
            source_no,
            dong,
            jibun,
            trade_date,
            land_area,
            src_values.cell(row, 7).value,
            abbreviation(src_values.cell(row, 8).value),
            "",
            src_values.cell(row, 25).value,
            "",
            "",
            src_values.cell(row, 12).value,
            unit_price,
            official_price,
            public_ratio,
            classify_review(src_values, row),
            "",
            "",
            crawl_status,
        ]
        out_row = idx + 4
        for col, value in enumerate(record, start=1):
            cell = ws.cell(out_row, col, value)
            cell.border = border
            cell.alignment = Alignment(vertical="center")
            if isinstance(value, datetime):
                cell.number_format = "yyyy-mm-dd"
            if col in (12, 13, 14):
                cell.number_format = "#,##0"
            if col == 15:
                cell.number_format = "0.0000"
        preview.append({HEADERS[i]: record[i] for i in range(len(HEADERS))})

    for row in ws.iter_rows(min_row=4, max_row=ws.max_row, min_col=1, max_col=len(HEADERS)):
        for cell in row:
            cell.border = border
    ws.auto_filter.ref = f"A4:{get_column_letter(len(HEADERS))}{ws.max_row}"

    log("엑셀 파일을 저장하는 중입니다.")
    wb.save(output_path)
    summary = {
        "sheetName": "자동정리",
        "caseCount": len(rows),
        "preview": json.loads(json.dumps(preview[:30], default=str, ensure_ascii=False)),
        "warnings": warnings,
    }
    Path(summary_path).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2], sys.argv[3])
