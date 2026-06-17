package service

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
)

func TestOtuapiResponsesViaChatCompletionsConvertsToolCalls(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatalf("missing authorization header")
		}
		var request otuapiChatRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if request.Model != "claude-opus-4-6" {
			t.Fatalf("model = %q", request.Model)
		}
		if len(request.Messages) != 2 {
			t.Fatalf("messages = %#v", request.Messages)
		}
		if len(request.Tools) != 1 || request.Tools[0].Function.Name != "canvas_get_state" {
			t.Fatalf("tools = %#v", request.Tools)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl-test","model":"claude-opus-4-6","choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"canvas_get_state","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`))
	}))
	defer server.Close()

	body, _ := json.Marshal(map[string]any{
		"model": "claude-opus-4-6",
		"input": []map[string]any{
			{"role": "system", "content": "You must call a tool."},
			{"role": "user", "content": "Read state."},
		},
		"tools": []map[string]any{{
			"type":        "function",
			"name":        "canvas_get_state",
			"description": "Read state",
			"parameters": map[string]any{
				"type":                 "object",
				"properties":           map[string]any{},
				"additionalProperties": false,
			},
		}},
		"tool_choice":         "required",
		"parallel_tool_calls": false,
	})
	responseBody, contentType, err := otuapiResponsesViaChatCompletions(model.ModelChannel{
		Protocol: "otuapi",
		BaseURL:  server.URL,
		APIKey:   "test-key",
	}, body)
	if err != nil {
		t.Fatalf("otuapiResponsesViaChatCompletions returned error: %v", err)
	}
	if contentType != "application/json" {
		t.Fatalf("content type = %q", contentType)
	}
	var payload otuapiResponsePayload
	if err := json.Unmarshal(responseBody, &payload); err != nil {
		t.Fatalf("decode response payload: %v", err)
	}
	if len(payload.Output) != 1 {
		t.Fatalf("output = %#v", payload.Output)
	}
	if payload.Output[0]["type"] != "function_call" || payload.Output[0]["name"] != "canvas_get_state" {
		t.Fatalf("unexpected output = %#v", payload.Output[0])
	}
	if payload.Output[0]["call_id"] != "call_1" {
		t.Fatalf("call_id = %#v", payload.Output[0]["call_id"])
	}
}

func TestOtuapiVideoCreatePathUsesCanonicalVideosEndpoint(t *testing.T) {
	channel := model.ModelChannel{Protocol: "otuapi", BaseURL: "https://otuapi.com"}
	if got := OtuapiProxyPath(channel, "gpt-image-2", "/images/generations"); got != "/videos" {
		t.Fatalf("async image path = %q, want /videos", got)
	}
	if got := OtuapiProxyPath(channel, "sora-2-12s", "/videos"); got != "/videos" {
		t.Fatalf("video create path = %q, want /videos", got)
	}
	if got := OtuapiProxyPath(channel, "sora-2-12s", "/videos/task_123"); got != "/videos/task_123" {
		t.Fatalf("video query path = %q, want /videos/task_123", got)
	}
}

func TestOtuapiUsesGeminiNativeChatOnlyForKnownWorkingTextModel(t *testing.T) {
	channel := model.ModelChannel{Protocol: "otuapi", BaseURL: "https://otuapi.com"}
	if !OtuapiUsesGeminiNativeChat(channel, "gemini-3.5-flash", "/chat/completions") {
		t.Fatal("gemini-3.5-flash should use Gemini native chat on Otuapi")
	}
	if OtuapiUsesGeminiNativeChat(channel, "gemini-3.1-pro-preview", "/chat/completions") {
		t.Fatal("gemini-3.1-pro-preview should not use Gemini native chat without a successful upstream test")
	}
	if OtuapiUsesGeminiNativeChat(channel, "gemini-3.5-flash", "/responses") {
		t.Fatal("Responses tool calls should not be routed to Gemini native chat")
	}
}

func TestOtuapiResponsesRejectsKnownUnstableToolModels(t *testing.T) {
	body, _ := json.Marshal(map[string]any{
		"model": "gemini-3.1-pro-preview",
		"input": []map[string]any{{"role": "user", "content": "read state"}},
		"tools": []map[string]any{{
			"type": "function",
			"name": "canvas_get_state",
			"parameters": map[string]any{"type": "object", "properties": map[string]any{}},
		}},
	})
	_, _, err := otuapiResponsesViaChatCompletions(model.ModelChannel{
		Protocol: "otuapi",
		BaseURL:  "https://otuapi.com",
		APIKey:   "test-key",
	}, body)
	if err == nil || !strings.Contains(err.Error(), "claude-opus-4-6") {
		t.Fatalf("expected explicit model guidance, got %v", err)
	}
}

func TestOtuapiResponsesAllowsGemini35FlashToolCalls(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request otuapiChatRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if request.Model != "gemini-3.5-flash" || len(request.Tools) != 1 {
			t.Fatalf("unexpected request = %#v", request)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl-test","model":"gemini-3.5-flash","choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"canvas_get_state","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`))
	}))
	defer server.Close()

	body, _ := json.Marshal(map[string]any{
		"model": "gemini-3.5-flash",
		"input": []map[string]any{{"role": "user", "content": "read state"}},
		"tools": []map[string]any{{
			"type": "function",
			"name": "canvas_get_state",
			"parameters": map[string]any{"type": "object", "properties": map[string]any{}},
		}},
	})
	responseBody, _, err := otuapiResponsesViaChatCompletions(model.ModelChannel{
		Protocol: "otuapi",
		BaseURL:  server.URL,
		APIKey:   "test-key",
	}, body)
	if err != nil {
		t.Fatalf("gemini-3.5-flash tool call should be converted: %v", err)
	}
	var payload otuapiResponsePayload
	if err := json.Unmarshal(responseBody, &payload); err != nil {
		t.Fatalf("decode response payload: %v", err)
	}
	if len(payload.Output) != 1 || payload.Output[0]["name"] != "canvas_get_state" {
		t.Fatalf("unexpected output = %#v", payload.Output)
	}
}

func TestOtuapiChatRequestUsesToolCallIDAndNameForToolMessages(t *testing.T) {
	request, err := otuapiChatRequestFromResponses(otuapiResponsesRequest{
		Model: "gemini-3.5-flash",
		Input: []otuapiResponseInput{
			{
				Type:      "function_call",
				CallID:    "call_123",
				Name:      "canvas_get_state",
				Arguments: "{}",
			},
			{
				Type:   "function_call_output",
				CallID: "call_123",
				Output: "ok",
			},
			{
				Role:       "tool",
				Name:       "canvas_get_selection",
				ToolCallID: "call_456",
				Content:    "ok",
			},
		},
	})
	if err != nil {
		t.Fatalf("build chat request: %v", err)
	}
	if len(request.Messages) != 3 {
		t.Fatalf("messages = %#v", request.Messages)
	}
	if request.Messages[1].ToolCallID != "call_123" {
		t.Fatalf("tool_call_id = %q, want call_123", request.Messages[1].ToolCallID)
	}
	if request.Messages[1].Name != "canvas_get_state" {
		t.Fatalf("tool name = %q, want canvas_get_state", request.Messages[1].Name)
	}
	if request.Messages[2].ToolCallID != "call_456" {
		t.Fatalf("tool_call_id = %q, want call_456", request.Messages[2].ToolCallID)
	}
	if request.Messages[2].Name != "canvas_get_selection" {
		t.Fatalf("tool name = %q, want canvas_get_selection", request.Messages[2].Name)
	}
}

func TestOtuapiChatRequestOmitsToolMessageNameForOpenAICompatibleModels(t *testing.T) {
	request, err := otuapiChatRequestFromResponses(otuapiResponsesRequest{
		Model: "claude-opus-4-6",
		Input: []otuapiResponseInput{
			{Type: "function_call", CallID: "call_123", Name: "canvas_get_state", Arguments: "{}"},
			{Type: "function_call_output", CallID: "call_123", Output: "ok"},
		},
	})
	if err != nil {
		t.Fatalf("build chat request: %v", err)
	}
	if request.Messages[1].Name != "" {
		t.Fatalf("tool name = %q, want empty", request.Messages[1].Name)
	}
}

func TestOtuapiChatRequestAddsGLM52Defaults(t *testing.T) {
	request, err := otuapiChatRequestFromResponses(otuapiResponsesRequest{
		Model: "glm-5.2",
		Input: []otuapiResponseInput{{Role: "user", Content: "hi"}},
	})
	if err != nil {
		t.Fatalf("build chat request: %v", err)
	}
	if request.MaxTokens == nil || *request.MaxTokens != 512 {
		t.Fatalf("max_tokens = %#v, want 512", request.MaxTokens)
	}
	thinking, ok := request.Thinking.(map[string]string)
	if !ok || thinking["type"] != "disabled" {
		t.Fatalf("thinking = %#v, want disabled", request.Thinking)
	}
}

func TestOtuapiChatRequestPreservesLargerGLM52MaxOutputTokens(t *testing.T) {
	maxTokens := 2048
	request, err := otuapiChatRequestFromResponses(otuapiResponsesRequest{
		Model:           "glm-5.2",
		Input:           []otuapiResponseInput{{Role: "user", Content: "hi"}},
		MaxOutputTokens: &maxTokens,
		Thinking:        map[string]string{"type": "enabled"},
	})
	if err != nil {
		t.Fatalf("build chat request: %v", err)
	}
	if request.MaxTokens == nil || *request.MaxTokens != 2048 {
		t.Fatalf("max_tokens = %#v, want 2048", request.MaxTokens)
	}
	thinking, ok := request.Thinking.(map[string]string)
	if !ok || thinking["type"] != "enabled" {
		t.Fatalf("thinking = %#v, want enabled", request.Thinking)
	}
}

func TestOpenAICompatibleResponsesViaChatCompletionsPostsToChatCompletions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/paas/v4/chat/completions" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		var request otuapiChatRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if request.Model != "glm-4.6" || len(request.Tools) != 1 {
			t.Fatalf("unexpected request = %#v", request)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl-test","model":"glm-4.6","choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	body, _ := json.Marshal(map[string]any{
		"model": "glm-4.6",
		"input": []map[string]any{{"role": "user", "content": "hi"}},
		"tools": []map[string]any{{
			"type": "function",
			"name": "canvas_get_state",
			"parameters": map[string]any{"type": "object", "properties": map[string]any{}},
		}},
	})
	responseBody, _, err := OpenAICompatibleResponsesViaChatCompletions(model.ModelChannel{
		BaseURL: server.URL + "/api/paas/v4",
		APIKey:  "test-key",
	}, body)
	if err != nil {
		t.Fatalf("OpenAICompatibleResponsesViaChatCompletions returned error: %v", err)
	}
	var payload otuapiResponsePayload
	if err := json.Unmarshal(responseBody, &payload); err != nil {
		t.Fatalf("decode response payload: %v", err)
	}
	if payload.OutputText != "ok" {
		t.Fatalf("output_text = %q, want ok", payload.OutputText)
	}
}

func TestOtuapiResponsesRejectsEmptyContentFilteredOutput(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl-test","model":"claude-opus-4-6","choices":[{"message":{"role":"assistant","content":""},"finish_reason":"content_filter"}]}`))
	}))
	defer server.Close()

	_, _, err := otuapiResponsesViaChatCompletions(model.ModelChannel{
		Protocol: "otuapi",
		BaseURL:  server.URL,
		APIKey:   "test-key",
	}, []byte(`{"model":"claude-opus-4-6","input":[{"role":"user","content":"hi"}],"tools":[]}`))
	if err == nil || !strings.Contains(err.Error(), "content_filter") {
		t.Fatalf("expected content_filter guidance, got %v", err)
	}
}
