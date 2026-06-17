package service

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

var geminiGenerateHTTPClient = &http.Client{Timeout: 65 * time.Second}

type GeminiPart struct {
	Text             string                  `json:"text,omitempty"`
	InlineData       *GeminiInlineData      `json:"inlineData,omitempty"`
	FunctionCall     *GeminiFunctionCall    `json:"functionCall,omitempty"`
	FunctionResponse *GeminiFunctionResponse `json:"function_response,omitempty"`
	ImageURL         *struct {
		URL string `json:"url,omitempty"`
	} `json:"image_url,omitempty"`
}

type GeminiInlineData struct {
	MimeType string `json:"mimeType,omitempty"`
	Data     string `json:"data,omitempty"`
}

type GeminiFunctionCall struct {
	Name string                 `json:"name,omitempty"`
	Args map[string]interface{} `json:"args,omitempty"`
}

type GeminiFunctionResponse struct {
	Name     string                 `json:"name,omitempty"`
	Response map[string]interface{} `json:"response,omitempty"`
}

type GeminiContent struct {
	Role  string       `json:"role,omitempty"`
	Parts []GeminiPart `json:"parts"`
}

type GeminiGenerateRequest struct {
	Contents          []GeminiContent        `json:"contents"`
	SystemInstruction *GeminiContent         `json:"systemInstruction,omitempty"`
	Tools             []GeminiTool           `json:"tools,omitempty"`
	ToolConfig        *GeminiToolConfig      `json:"toolConfig,omitempty"`
	GenerationConfig  map[string]interface{} `json:"generationConfig,omitempty"`
}

type GeminiTool struct {
	FunctionDeclarations []GeminiFunctionDeclaration `json:"functionDeclarations,omitempty"`
}

type GeminiFunctionDeclaration struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description,omitempty"`
	Parameters  map[string]interface{} `json:"parameters,omitempty"`
}

type GeminiToolConfig struct {
	FunctionCallingConfig *GeminiFunctionCallingConfig `json:"functionCallingConfig,omitempty"`
}

type GeminiFunctionCallingConfig struct {
	Mode                 string   `json:"mode,omitempty"`
	AllowedFunctionNames []string `json:"allowedFunctionNames,omitempty"`
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

func GeminiResponsesViaGenerateContent(channel model.ModelChannel, body []byte) ([]byte, string, error) {
	var responsesRequest otuapiResponsesRequest
	if err := json.Unmarshal(body, &responsesRequest); err != nil {
		return nil, "", safeMessageError{message: "Responses 请求解析失败"}
	}
	geminiRequest, err := geminiGenerateRequestFromResponses(responsesRequest)
	if err != nil {
		return nil, "", err
	}
	requestBody, _ := json.Marshal(geminiRequest)
	responseBody, err := doGeminiGenerate(channel, responsesRequest.Model, requestBody)
	if err != nil {
		return nil, "", err
	}
	geminiPayload, err := parseGeminiPayload(responseBody)
	if err != nil {
		return nil, "", err
	}
	payload, content, err := geminiResponsesPayloadFromGenerate(geminiPayload, responsesRequest.Model)
	if err != nil {
		return nil, "", err
	}
	if responsesRequest.Stream {
		event, _ := json.Marshal(map[string]interface{}{"type": "response.output_text.done", "text": content})
		completed, _ := json.Marshal(map[string]interface{}{"type": "response.completed", "response": payload})
		return []byte("data: " + string(event) + "\n\ndata: " + string(completed) + "\n\ndata: [DONE]\n\n"), "text/event-stream", nil
	}
	encoded, _ := json.Marshal(payload)
	return encoded, "application/json", nil
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
	setGeminiAuthHeader(request, channel)
	response, err := geminiGenerateHTTPClient.Do(request)
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
	case "/responses":
		return nil, "", safeMessageError{message: "Gemini 调用格式暂不支持 Responses 工具调用，请使用 OpenAI 兼容渠道"}
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
		Size   string `json:"size"`
		Quality string `json:"quality"`
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
			GenerationConfig: geminiImageGenerationConfig(channel, payload.Model, payload.Size, payload.Quality),
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

func geminiImageGenerationConfig(channel model.ModelChannel, modelName string, size string, quality string) map[string]interface{} {
	config := map[string]interface{}{
		"responseModalities": []string{"TEXT", "IMAGE"},
	}
	if !IsOtuapiChannel(channel) {
		return config
	}
	config["responseModalities"] = []string{"IMAGE"}
	imageConfig := map[string]interface{}{}
	if ratio := geminiAspectRatioFromSize(size); ratio != "" {
		imageConfig["aspectRatio"] = ratio
	}
	if imageSize := geminiImageSizeFromQuality(modelName, quality); imageSize != "" {
		imageConfig["imageSize"] = imageSize
	}
	if len(imageConfig) > 0 {
		config["imageConfig"] = imageConfig
	}
	return config
}

func geminiImageSizeFromQuality(modelName string, quality string) string {
	if !strings.Contains(strings.ToLower(modelName), "flash-image") {
		return ""
	}
	switch strings.ToLower(strings.TrimSpace(quality)) {
	case "low", "standard", "1k":
		return "1K"
	case "medium", "hd", "2k":
		return "2K"
	case "high", "4k":
		return "4K"
	default:
		return ""
	}
}

func geminiAspectRatioFromSize(size string) string {
	value := strings.TrimSpace(size)
	if value == "" || strings.EqualFold(value, "auto") {
		return ""
	}
	if strings.Contains(value, ":") {
		return value
	}
	parts := strings.Split(strings.ToLower(value), "x")
	if len(parts) != 2 {
		return ""
	}
	width, height := parsePositiveInt(parts[0]), parsePositiveInt(parts[1])
	if width <= 0 || height <= 0 {
		return ""
	}
	return reduceRatio(width, height)
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

func geminiGenerateRequestFromResponses(request otuapiResponsesRequest) (GeminiGenerateRequest, error) {
	contents := []GeminiContent{}
	systemParts := []GeminiPart{}
	toolCallNames := map[string]string{}
	for _, item := range request.Input {
		switch {
		case item.Type == "function_call":
			args := map[string]interface{}{}
			if strings.TrimSpace(item.Arguments) != "" {
				_ = json.Unmarshal([]byte(item.Arguments), &args)
			}
			toolCallNames[item.CallID] = item.Name
			contents = append(contents, GeminiContent{
				Role:  "model",
				Parts: []GeminiPart{{FunctionCall: &GeminiFunctionCall{Name: item.Name, Args: args}}},
			})
		case item.Type == "function_call_output" || item.Role == "tool":
			toolCallID := item.CallID
			if toolCallID == "" {
				toolCallID = item.ToolCallID
			}
			name := item.Name
			if name == "" {
				name = toolCallNames[toolCallID]
			}
			response := geminiFunctionResponsePayload(item.Output, item.Content)
			contents = append(contents, GeminiContent{
				Role:  "user",
				Parts: []GeminiPart{{FunctionResponse: &GeminiFunctionResponse{Name: name, Response: response}}},
			})
		case item.Role != "":
			parts, err := geminiPartsFromResponsesContent(item.Content)
			if err != nil {
				return GeminiGenerateRequest{}, err
			}
			role := strings.ToLower(strings.TrimSpace(item.Role))
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
	}
	result := GeminiGenerateRequest{
		Contents: contents,
		Tools:    geminiToolsFromResponses(request.Tools),
	}
	if len(systemParts) > 0 {
		result.SystemInstruction = &GeminiContent{Parts: systemParts}
	}
	if len(result.Tools) > 0 {
		result.ToolConfig = geminiToolConfigFromResponses(request.ToolChoice, request.Tools)
	}
	if strings.TrimSpace(request.Model) == "" {
		return result, safeMessageError{message: "缺少模型名称"}
	}
	if len(result.Contents) == 0 {
		return result, safeMessageError{message: "缺少对话内容"}
	}
	return result, nil
}

func geminiPartsFromResponsesContent(content any) ([]GeminiPart, error) {
	if items, ok := content.([]interface{}); ok {
		parts := []GeminiPart{}
		for _, raw := range items {
			item, ok := raw.(map[string]interface{})
			if !ok {
				continue
			}
			switch item["type"] {
			case "input_text", "text":
				parts = append(parts, GeminiPart{Text: stringValue(item["text"])})
			case "input_image", "image_url":
				imageURL := stringValue(item["image_url"])
				if imageURL == "" {
					if nested, ok := item["image_url"].(map[string]interface{}); ok {
						imageURL = stringValue(nested["url"])
					}
				}
				inline, err := geminiInlineDataFromURL(imageURL)
				if err != nil {
					return nil, err
				}
				parts = append(parts, GeminiPart{InlineData: inline})
			}
		}
		if len(parts) > 0 {
			return parts, nil
		}
	}
	return []GeminiPart{{Text: stringValue(content)}}, nil
}

func geminiFunctionResponsePayload(output string, content any) map[string]interface{} {
	text := output
	if text == "" {
		text = stringValue(content)
	}
	result := map[string]interface{}{}
	if strings.TrimSpace(text) != "" && json.Unmarshal([]byte(text), &result) == nil && len(result) > 0 {
		return result
	}
	return map[string]interface{}{"output": text}
}

func geminiToolsFromResponses(tools []otuapiResponseTool) []GeminiTool {
	declarations := []GeminiFunctionDeclaration{}
	for _, tool := range tools {
		name := tool.Name
		description := tool.Description
		parameters := tool.Parameters
		if name == "" && tool.Function != nil {
			name = tool.Function.Name
			description = tool.Function.Description
			parameters = tool.Function.Parameters
		}
		if strings.TrimSpace(name) == "" {
			continue
		}
		declarations = append(declarations, GeminiFunctionDeclaration{Name: name, Description: description, Parameters: parameters})
	}
	if len(declarations) == 0 {
		return nil
	}
	return []GeminiTool{{FunctionDeclarations: declarations}}
}

func geminiToolConfigFromResponses(toolChoice any, tools []otuapiResponseTool) *GeminiToolConfig {
	config := &GeminiToolConfig{FunctionCallingConfig: &GeminiFunctionCallingConfig{Mode: "AUTO"}}
	if text, ok := toolChoice.(string); ok && text == "required" {
		config.FunctionCallingConfig.Mode = "ANY"
		return config
	}
	if item, ok := toolChoice.(map[string]interface{}); ok && item["type"] == "function" {
		if name := stringValue(item["name"]); name != "" {
			config.FunctionCallingConfig.Mode = "ANY"
			config.FunctionCallingConfig.AllowedFunctionNames = []string{name}
			return config
		}
	}
	_ = tools
	return config
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
	setGeminiAuthHeader(request, channel)
	request.Header.Set("Content-Type", "application/json")
	response, err := geminiGenerateHTTPClient.Do(request)
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

func geminiResponsesPayloadFromGenerate(payload GeminiGenerateResponse, fallbackModel string) (otuapiResponsePayload, string, error) {
	output := []map[string]interface{}{}
	outputText := ""
	callIndex := 0
	for _, part := range geminiParts(payload) {
		if strings.TrimSpace(part.Text) != "" {
			outputText += part.Text
		}
		if part.FunctionCall != nil && strings.TrimSpace(part.FunctionCall.Name) != "" {
			callIndex++
			arguments := "{}"
			if part.FunctionCall.Args != nil {
				encoded, _ := json.Marshal(part.FunctionCall.Args)
				arguments = string(encoded)
			}
			callID := "call_" + part.FunctionCall.Name + "_" + strconv.Itoa(callIndex)
			output = append(output, map[string]interface{}{
				"type":      "function_call",
				"id":        callID,
				"call_id":   callID,
				"name":      part.FunctionCall.Name,
				"arguments": arguments,
			})
		}
	}
	if outputText != "" {
		output = append([]map[string]interface{}{{
			"type":    "message",
			"content": []map[string]string{{"type": "output_text", "text": outputText}},
		}}, output...)
	}
	if len(output) == 0 {
		return otuapiResponsePayload{}, "", safeOtuapiModelError{model: fallbackModel, message: "模型没有返回工具调用或文本内容"}
	}
	return otuapiResponsePayload{Object: "response", Model: fallbackModel, Output: output, OutputText: outputText}, outputText, nil
}

func geminiFirstImage(payload GeminiGenerateResponse) (map[string]string, error) {
	for _, part := range geminiParts(payload) {
		if part.ImageURL != nil && part.ImageURL.URL != "" {
			return map[string]string{"url": part.ImageURL.URL}, nil
		}
		if part.InlineData == nil || part.InlineData.Data == "" {
			continue
		}
		return map[string]string{"b64_json": part.InlineData.Data}, nil
	}
	return nil, safeMessageError{message: "Gemini 接口没有返回图片"}
}

func setGeminiAuthHeader(request *http.Request, channel model.ModelChannel) {
	if OtuapiUsesBearerAuth(channel) {
		request.Header.Set("Authorization", "Bearer "+channel.APIKey)
		return
	}
	request.Header.Set("x-goog-api-key", channel.APIKey)
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
