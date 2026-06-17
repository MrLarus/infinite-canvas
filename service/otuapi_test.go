package service

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

func TestOtuapiVideoCreatePathUsesTrailingSlash(t *testing.T) {
	channel := model.ModelChannel{Protocol: "otuapi", BaseURL: "https://otuapi.com"}
	if got := OtuapiProxyPath(channel, "gpt-image-2", "/images/generations"); got != "/videos/" {
		t.Fatalf("async image path = %q, want /videos/", got)
	}
	if got := OtuapiProxyPath(channel, "sora-2-12s", "/videos"); got != "/videos/" {
		t.Fatalf("video create path = %q, want /videos/", got)
	}
	if got := OtuapiProxyPath(channel, "sora-2-12s", "/videos/task_123"); got != "/videos/task_123" {
		t.Fatalf("video query path = %q, want /videos/task_123", got)
	}
}
