# Toji

토지 거래 엑셀 자동 정리 도구입니다.

## 기능

- 원본 `.xlsx` 업로드
- 첫 번째 원본 탭 분석
- `자동정리` 탭 추가
- `realtyprice.kr` 개별지 공시지가 조회 보강
- 다운로드 폴더에 날짜/수정버전 기준으로 결과 저장
- 브라우저에서 결과 엑셀 다운로드

## 실행

```bash
npm run dev
```

기본 주소:

```text
http://127.0.0.1:5180
```

## 저장 규칙

결과 파일은 항상 아래 위치에 저장됩니다.

```text
~/Downloads/토지거래 정리/토지거래 정리 YYYY-MM-DD/토지거래 정리 YYYY-MM-DD 수정vN.xlsx
```

같은 날짜에 여러 번 생성하면 `수정v1`, `수정v2`처럼 버전이 증가합니다.

## 참고

원본 엑셀에 포함된 외부 링크와 도형 파트는 Excel 복구 팝업을 피하기 위해 결과 저장 시 제거합니다.

## Microsoft 365 웹 편집 설정

Office 365 버튼은 처리 완료된 엑셀 파일을 OneDrive에 업로드한 뒤 Excel Online 편집 URL로 이동합니다. 사용하려면 Microsoft Entra ID 앱 등록이 필요합니다.

Render 환경변수:

```text
MS_CLIENT_ID=Azure 앱 등록의 Application client ID
MS_CLIENT_SECRET=선택 사항. Confidential client로 쓸 때만 입력
MS_TENANT_ID=common 또는 테넌트 ID
PUBLIC_BASE_URL=https://toji-hwux.onrender.com
```

Azure 앱 등록의 Redirect URI:

```text
https://toji-hwux.onrender.com/auth/microsoft/callback
```

필요 권한:

```text
User.Read
Files.ReadWrite
offline_access
```
