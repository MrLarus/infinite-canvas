package handler

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAIUpstreamErrorDetail(t *testing.T) {
	got := aiUpstreamErrorDetail([]byte(`{"error":{"code":"InvalidParameter","message":"reference video fps is invalid"}}`))
	if got != "InvalidParameter reference video fps is invalid" {
		t.Fatalf("detail = %q", got)
	}
}

func TestAIUpstreamErrorDetailExplainsSensitiveVideo(t *testing.T) {
	got := aiUpstreamErrorDetail([]byte(`{"error":{"code":"InputVideoSensitiveContentDetected.PrivacyInformation","message":"The request failed because the input video may contain real person."}}`))
	if !strings.Contains(got, "参考视频疑似包含真人") || !strings.Contains(got, "asset://") {
		t.Fatalf("detail = %q", got)
	}
	if strings.Contains(got, "火山方舟") {
		t.Fatalf("detail should hide provider name: %q", got)
	}
}

func TestSafeUpstreamTextTruncates(t *testing.T) {
	got := safeUpstreamText(strings.Repeat("错", 320))
	if len([]rune(got)) != 303 {
		t.Fatalf("truncated rune length = %d", len([]rune(got)))
	}
}

func TestReadAIRequestCountDefaultsGeminiSingleImage(t *testing.T) {
	body, _ := json.Marshal(map[string]any{"model": "gemini-2.5-flash-image"})
	if got := readAIRequestCount(body, "application/json"); got != 1 {
		t.Fatalf("count = %d, want 1", got)
	}
}

func TestSanitizeAIUserMessageHidesProviderNames(t *testing.T) {
	got := sanitizeAIUserMessage("章鱼哥 Gemini 原生接口失败，火山方舟 Agent Plan 无响应，GLM Coding Plan 错误")
	blocked := []string{"章鱼哥", "Otuapi", "otuapi", "Gemini", "火山方舟", "Agent Plan", "GLM Coding Plan"}
	for _, item := range blocked {
		if strings.Contains(got, item) {
			t.Fatalf("message %q still contains %q", got, item)
		}
	}
}
