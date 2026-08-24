// ⚠️ 이 파일에 본인의 Google OAuth 클라이언트 ID를 넣어주세요.
// 발급 방법은 README.md의 "Google Drive 연동 설정" 부분을 참고하세요.
const GOOGLE_CLIENT_ID = "104858973577-7naknkqhdaaav9lghv3m6cfca1s53scr.apps.googleusercontent.com";

// Drive에 저장될 데이터 파일 이름 (보통 수정할 필요 없음)
const DRIVE_FILE_NAME = "가계부_data.json";

// Drive API 접근 범위: 이 앱이 만든 파일에만 접근 (계정의 다른 파일에는 접근하지 않음)
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
