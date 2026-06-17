package service

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
)

type GeminiPart struct {
	Text       string             `json:"text,omitempty"`
	InlineData *GeminiInlineData `json:"inlineData,omitempty"`
}

type GeminiInlineData struct {
	MimeType string `json:"mimeType,omitempty"`
	Data     string `json:"data,omitempty"`
}

type GeminiContent struct {
	Role  string       `json:"role,omitempty"`
	Parts []GeminiPart `json:"parts"`
}

type GeminiGenerateRequest struct {
	Contents          []GeminiContent        `json:"contents"`
	SystemInstruction *GeminiContent         `json:"systemInstruction,omitempty"`
	GenerationConfig  map[string]interface{} `json:"generationConfig,omitempty"`
}

type GeminiGenerateResponse struct {
	Candidates []struct {
		Content *GeminiContent `json:"content,omitempty"`
	} `json:"candidates,omitempty"`
	PromptFeedback *struct {
		BlockReason string `json:"blockReason,omitempty"`
	} `json:"promptFeedback,omitempty"`
	Error *struct {
		Message string `json:"message,omitempty"`
	} `json:"error,omitempty"`
}

type OpenAIChatMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

func IsGeminiChannel(channel model.ModelChannel) bool {
	return strings.EqualFold(strings.TrimSpace(channel.Protocol), "gemini")
}

func GeminiModelName(modelName string) string {
	return strings.TrimPrefix(strings.TrimSpace(modelName), "models/")
}

func BuildGeminiURL(channel model.ModelChannel, modelName string, action string) string {
	baseURL := geminiBaseURL(channel.BaseURL)
	if action == "" {
		return baseURL + "/models"
	}
	return baseURL + "/models/" + url.PathEscape(GeminiModelName(modelName)) + ":" + action
}

func GeminiFetchModels(channel model.ModelChannel) ([]string, error) {
	request, err := http.NewRequest(http.MethodGet, BuildGeminiURL(channel, "", ""), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("x-goog-api-key", channel.APIKey)
	response, err := adminModelHTTPClient.Do(request)
	if err != nil {
		return nil, safeMessageError{message: "读取模型失败：Gemini 接口无响应或网络不可达"}
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		return nil, readAdminChannelError(body, response.StatusCode, "读取 Gemini 模型失败")
	}
	var payload struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	_ = json.Unmarshal(body, &payload)
	result := make([]string, 0, len(payload.Models))
	for _, item := range payload.Models {
		name := GeminiModelName(item.Name)
		if name != "" {
			result = append(result, name)
		}
	}
	sort.Strings(result)
	return result, nil
}

func GeminiTestModel(channel model.ModelChannel, modelName string) (string, error) {
	requestBody, _ := json.Marshal(GeminiGenerateRequest{
		Contents: []GeminiContent{{Role: "user", Parts: []GeminiPart{{Text: "hi"}}}},
	})
	responseBody, err := doGeminiGenerate(channel, modelName, requestBody)
	if err != nil {
		return "", err
	}
	payload, err := parseGeminiPayload(responseBody)
	if err != nil {
		return "", err
	}
	text := geminiText(payload)
	if text == "" {
		return "ok", nil
	}
	return text, nil
}

func GeminiProxyRequest(channel model.ModelChannel, path string, body []byte, contentType string) ([]byte, string, error) {
	_ = contentType
	switch path {
	case "/chat/completions":
		return geminiChatCompletions(channel, body)
	case "/images/generations":
		return geminiImageGenerations(channel, body)
	case "/images/edits":
		return nil, "", safeMessageError{message: "Gemini 调用格式暂不支持图片编辑，请使用 OpenAI 兼容渠道"}
	case "/audio/speech":
		return nil, "", safeMessageError{message: "Gemini 调用格式暂不支持音频生成，请使用 OpenAI 兼容渠道"}
	case "/videos":
		return nil, "", safeMessageError{message: "Gemini 调用格式暂不支持视频生成，请使用 OpenAI 兼容渠道"}
	default:
		return nil, "", safeMessageError{message: "Gemini 调用格式暂不支持该接口"}
	}
}

func geminiChatCompletions(channel model.ModelChannel, body []byte) ([]byte, string, error) {
	var payload struct {
		Model    string              `json:"model"`
		Messages []OpenAIChatMessage `json:"messages"`
		Stream   bool                `json:"stream"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, "", safeMessageError{message: "Gemini 文本请求解析失败"}
	}
	requestBody, err := geminiBodyFromChatMessages(payload.Messages)
	if err != nil {
		return nil, "", err
	}
	responseBody, err := doGeminiGenerate(channel, payload.Model, requestBody)
	if err != nil {
		return nil, "", err
	}
	geminiPayload, err := parseGeminiPayload(responseBody)
	if err != nil {
		return nil, "", err
	}
	text := geminiText(geminiPayload)
	if payload.Stream {
		event, _ := json.Marshal(map[string]interface{}{
			"choices": []map[string]interface{}{
				{"delta": map[string]string{"content": text}},
			},
		})
		return []byte("data: " + string(event) + "\n\ndata: [DONE]\n\n"), "text/event-stream", nil
	}
	openAI, _ := json.Marshal(map[string]interface{}{
		"choices": []map[string]interface{}{
			{"message": map[string]string{"role": "assistant", "content": text}},
		},
	})
	return openAI, "application/json", nil
}

func geminiImageGenerations(channel model.ModelChannel, body []byte) ([]byte, string, error) {
	var payload struct {
		Model  string `json:"model"`
		Prompt string `json:"prompt"`
		N      int    `json:"n"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, "", safeMessageError{message: "Gemini 图片请求解析失败"}
	}
	count := payload.N
	if count < 1 {
		count = 1
	}
	if count > 15 {
		count = 15
	}
	images := make([]map[string]string, 0, count)
	for i := 0; i < count; i++ {
		requestBody, _ := json.Marshal(GeminiGenerateRequest{
			Contents: []GeminiContent{{Role: "user", Parts: []GeminiPart{{Text: payload.Prompt}}}},
			GenerationConfig: map[string]interface{}{
				"responseModalities": []string{"TEXT", "IMAGE"},
			},
		})
		responseBody, err := doGeminiGenerate(channel, payload.Model, requestBody)
		if err != nil {
			return nil, "", err
		}
		geminiPayload, err := parseGeminiPayload(responseBody)
		if err != nil {
			return nil, "", err
		}
		image, err := geminiFirstImage(geminiPayload)
		if err != nil {
			return nil, "", err
		}
		images = append(images, image)
	}
	openAI, _ := json.Marshal(map[string]interface{}{"data": images})
	return openAI, "application/json", nil
}

func geminiBodyFromChatMessages(messages []OpenAIChatMessage) ([]byte, error) {
	contents := []GeminiContent{}
	systemParts := []GeminiPart{}
	for _, message := range messages {
		parts, err := geminiPartsFromOpenAIContent(message.Content)
		if err != nil {
			return nil, err
		}
		role := strings.ToLower(strings.TrimSpace(message.Role))
		if role == "system" {
			systemParts = append(systemParts, parts...)
			continue
		}
		if role == "assistant" {
			role = "model"
		} else {
			role = "user"
		}
		contents = append(contents, GeminiContent{Role: role, Parts: parts})
	}
	request := GeminiGenerateRequest{Contents: contents}
	if len(systemParts) > 0 {
		request.SystemInstruction = &GeminiContent{Parts: systemParts}
	}
	return json.Marshal(request)
}

func geminiPartsFromOpenAIContent(raw json.RawMessage) ([]GeminiPart, error) {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return []GeminiPart{{Text: text}}, nil
	}
	var items []struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		ImageURL *struct {
			URL string `json:"url"`
		} `json:"image_url"`
	}
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, safeMessageError{message: "Gemini 文本内容格式不支持"}
	}
	parts := []GeminiPart{}
	for _, item := range items {
		if item.Type == "text" {
			parts = append(parts, GeminiPart{Text: item.Text})
			continue
		}
		if item.Type == "image_url" && item.ImageURL != nil {
			inline, err := geminiInlineDataFromURL(item.ImageURL.URL)
			if err != nil {
				return nil, err
			}
			parts = append(parts, GeminiPart{InlineData: inline})
		}
	}
	return parts, nil
}

func geminiInlineDataFromURL(value string) (*GeminiInlineData, error) {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, "data:") {
		return nil, safeMessageError{message: "Gemini 原生接口暂只支持 data URL 参考图"}
	}
	header, data, ok := strings.Cut(strings.TrimPrefix(value, "data:"), ",")
	if !ok {
		return nil, safeMessageError{message: "Gemini 参考图格式不正确"}
	}
	mimeType := strings.TrimSuffix(strings.TrimSuffix(header, ";base64"), ";")
	if mimeType == "" {
		mimeType = "image/png"
	}
	return &GeminiInlineData{MimeType: mimeType, Data: data}, nil
}

func doGeminiGenerate(channel model.ModelChannel, modelName string, body []byte) ([]byte, error) {
	request, err := http.NewRequest(http.MethodPost, BuildGeminiURL(channel, modelName, "generateContent"), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("x-goog-api-key", channel.APIKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := adminModelHTTPClient.Do(request)
	if err != nil {
		return nil, safeMessageError{message: "Gemini 接口无响应或网络不可达"}
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		return nil, readAdminChannelError(responseBody, response.StatusCode, "Gemini 请求失败")
	}
	return responseBody, nil
}

func geminiBaseURL(baseURL string) string {
	normalized := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if normalized == "" {
		normalized = "https://generativelanguage.googleapis.com"
	}
	lower := strings.ToLower(normalized)
	if strings.HasSuffix(lower, "/v1") || strings.HasSuffix(lower, "/v1beta") {
		return normalized
	}
	return normalized + "/v1beta"
}

func parseGeminiPayload(body []byte) (GeminiGenerateResponse, error) {
	var payload GeminiGenerateResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return payload, safeMessageError{message: "Gemini 响应解析失败"}
	}
	if payload.Error != nil && strings.TrimSpace(payload.Error.Message) != "" {
		return payload, safeMessageError{message: payload.Error.Message}
	}
	if payload.PromptFeedback != nil && payload.PromptFeedback.BlockReason != "" {
		return payload, safeMessageError{message: "Gemini 拒绝了本次请求：" + payload.PromptFeedback.BlockReason}
	}
	return payload, nil
}

func geminiText(payload GeminiGenerateResponse) string {
	parts := geminiParts(payload)
	texts := []string{}
	for _, part := range parts {
		if strings.TrimSpace(part.Text) != "" {
			texts = append(texts, part.Text)
		}
	}
	return strings.Join(texts, "")
}

func geminiFirstImage(payload GeminiGenerateResponse) (map[string]string, error) {
	for _, part := range geminiParts(payload) {
		if part.InlineData == nil || part.InlineData.Data == "" {
			continue
		}
		return map[string]string{"b64_json": part.InlineData.Data}, nil
	}
	return nil, safeMessageError{message: "Gemini 接口没有返回图片"}
}

func geminiParts(payload GeminiGenerateResponse) []GeminiPart {
	result := []GeminiPart{}
	for _, candidate := range payload.Candidates {
		if candidate.Content != nil {
			result = append(result, candidate.Content.Parts...)
		}
	}
	return result
}

func GeminiUnsupportedGet(path string) error {
	if strings.HasPrefix(path, "/videos/") {
		return safeMessageError{message: "Gemini 调用格式暂不支持视频任务查询"}
	}
	return safeMessageError{message: "Gemini 调用格式暂不支持该接口"}
}
