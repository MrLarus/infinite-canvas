package service

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestGeminiGenerateRequestFromResponsesIncludesFunctionResponseName(t *testing.T) {
	request, err := geminiGenerateRequestFromResponses(otuapiResponsesRequest{
		Model: "gemini-3.5-flash",
		Input: []otuapiResponseInput{
			{Role: "user", Content: "读取画布"},
			{Type: "function_call", CallID: "call_123", Name: "canvas_get_state", Arguments: "{}"},
			{Type: "function_call_output", CallID: "call_123", Output: `{"ok":true,"message":"done"}`},
		},
		Tools: []otuapiResponseTool{{
			Type:        "function",
			Name:        "canvas_get_state",
			Description: "Read canvas state",
			Parameters:  map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
		}},
		ToolChoice: "required",
	})
	if err != nil {
		t.Fatalf("build gemini request: %v", err)
	}
	if len(request.Contents) != 3 {
		t.Fatalf("contents = %#v", request.Contents)
	}
	response := request.Contents[2].Parts[0].FunctionResponse
	if response == nil {
		t.Fatalf("missing functionResponse: %#v", request.Contents[2].Parts[0])
	}
	if response.Name != "canvas_get_state" {
		t.Fatalf("functionResponse.name = %q, want canvas_get_state", response.Name)
	}
	if request.ToolConfig == nil || request.ToolConfig.FunctionCallingConfig == nil || request.ToolConfig.FunctionCallingConfig.Mode != "ANY" {
		t.Fatalf("tool config = %#v", request.ToolConfig)
	}
	encoded, _ := json.Marshal(request)
	if !json.Valid(encoded) {
		t.Fatalf("request is not valid json")
	}
	if !jsonContains(encoded, `"function_response"`) {
		t.Fatalf("request should use Otuapi Gemini function_response field: %s", string(encoded))
	}
}

func TestGeminiResponsesPayloadFromGenerateConvertsFunctionCall(t *testing.T) {
	payload, _, err := geminiResponsesPayloadFromGenerate(GeminiGenerateResponse{
		Candidates: []struct {
			Content *GeminiContent `json:"content,omitempty"`
		}{{
			Content: &GeminiContent{Role: "model", Parts: []GeminiPart{{
				FunctionCall: &GeminiFunctionCall{Name: "canvas_get_state", Args: map[string]interface{}{}},
			}}},
		}},
	}, "gemini-3.5-flash")
	if err != nil {
		t.Fatalf("convert gemini payload: %v", err)
	}
	if len(payload.Output) != 1 || payload.Output[0]["name"] != "canvas_get_state" {
		t.Fatalf("output = %#v", payload.Output)
	}
	if payload.Output[0]["call_id"] == "" {
		t.Fatalf("missing call_id: %#v", payload.Output[0])
	}
}

func TestGeminiAspectRatioFromSizeCanonicalizesGeneratedDimensions(t *testing.T) {
	cases := map[string]string{
		"1024x1824": "9:16",
		"1824x1024": "16:9",
		"1024x1360": "3:4",
		"1360x1024": "4:3",
		"9:16":      "9:16",
		"32:57":     "9:16",
		"1000x1000": "1:1",
	}
	for size, want := range cases {
		if got := geminiAspectRatioFromSize(size); got != want {
			t.Fatalf("geminiAspectRatioFromSize(%q) = %q, want %q", size, got, want)
		}
	}
}

func jsonContains(body []byte, value string) bool {
	return strings.Contains(string(body), value)
}
