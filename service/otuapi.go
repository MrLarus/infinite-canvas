package service

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

var otuapiModelHTTPClient = &http.Client{Timeout: 65 * time.Second}

type OtuapiProxyResult struct {
	Handled     bool
	Body        []byte
	ContentType string
	Err         error
}

type otuapiResponsesRequest struct {
	Model             string                 `json:"model"`
	Input             []otuapiResponseInput  `json:"input"`
	Tools             []otuapiResponseTool   `json:"tools"`
	ToolChoice        any                    `json:"tool_choice"`
	ParallelToolCalls bool                   `json:"parallel_tool_calls"`
	Stream            bool                   `json:"stream"`
	Temperature       *float64               `json:"temperature,omitempty"`
	TopP              *float64               `json:"top_p,omitempty"`
	MaxOutputTokens   *int                   `json:"max_output_tokens,omitempty"`
	Extra             map[string]interface{} `json:"-"`
}

type otuapiResponseInput struct {
	Role       string                    `json:"role,omitempty"`
	Content    any                       `json:"content,omitempty"`
	Type       string                    `json:"type,omitempty"`
	CallID     string                    `json:"call_id,omitempty"`
	Name       string                    `json:"name,omitempty"`
	Arguments  string                    `json:"arguments,omitempty"`
	ToolCallID string                    `json:"tool_call_id,omitempty"`
	Output     string                    `json:"output,omitempty"`
	Extra      map[string]json.RawMessage `json:"-"`
}

type otuapiResponseTool struct {
	Type        string                 `json:"type"`
	Name        string                 `json:"name,omitempty"`
	Description string                 `json:"description,omitempty"`
	Parameters  map[string]interface{} `json:"parameters,omitempty"`
	Strict      *bool                  `json:"strict,omitempty"`
	Function    *struct {
		Name        string                 `json:"name"`
		Description string                 `json:"description,omitempty"`
		Parameters  map[string]interface{} `json:"parameters,omitempty"`
		Strict      *bool                  `json:"strict,omitempty"`
	} `json:"function,omitempty"`
}

type otuapiChatMessage struct {
	Role       string              `json:"role"`
	Content    any                 `json:"content,omitempty"`
	ToolCallID string              `json:"tool_call_id,omitempty"`
	ToolCalls  []otuapiChatToolCall `json:"tool_calls,omitempty"`
}

type otuapiChatTool struct {
	Type     string                 `json:"type"`
	Function otuapiChatToolFunction `json:"function"`
}

type otuapiChatToolFunction struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description,omitempty"`
	Parameters  map[string]interface{} `json:"parameters,omitempty"`
	Strict      *bool                  `json:"strict,omitempty"`
	Arguments   string                 `json:"arguments,omitempty"`
}

type otuapiChatToolCall struct {
	ID       string                 `json:"id"`
	Type     string                 `json:"type"`
	Function otuapiChatToolFunction `json:"function"`
}

type otuapiChatRequest struct {
	Model             string              `json:"model"`
	Messages          []otuapiChatMessage  `json:"messages"`
	Tools             []otuapiChatTool     `json:"tools,omitempty"`
	ToolChoice        any                 `json:"tool_choice,omitempty"`
	ParallelToolCalls bool                `json:"parallel_tool_calls,omitempty"`
	Stream            bool                `json:"stream,omitempty"`
	Temperature       *float64            `json:"temperature,omitempty"`
	TopP              *float64            `json:"top_p,omitempty"`
	MaxTokens          *int                `json:"max_tokens,omitempty"`
}

type otuapiChatResponse struct {
	ID      string `json:"id,omitempty"`
	Object  string `json:"object,omitempty"`
	Created int64  `json:"created,omitempty"`
	Model   string `json:"model,omitempty"`
	Choices []struct {
		Message struct {
			Role      string              `json:"role,omitempty"`
			Content   any                 `json:"content,omitempty"`
			ToolCalls []otuapiChatToolCall `json:"tool_calls,omitempty"`
		} `json:"message"`
		Delta struct {
			Content   string              `json:"content,omitempty"`
			ToolCalls []otuapiChatToolCall `json:"tool_calls,omitempty"`
		} `json:"delta,omitempty"`
		FinishReason string `json:"finish_reason,omitempty"`
	} `json:"choices,omitempty"`
	Error *struct {
		Message string `json:"message,omitempty"`
	} `json:"error,omitempty"`
}

type otuapiResponsePayload struct {
	ID         string                     `json:"id,omitempty"`
	Object     string                     `json:"object"`
	Model      string                     `json:"model,omitempty"`
	Output     []map[string]interface{}   `json:"output"`
	OutputText string                     `json:"output_text"`
	Error      *struct {
		Message string `json:"message,omitempty"`
	} `json:"error,omitempty"`
}

func IsOtuapiChannel(channel model.ModelChannel) bool {
	if strings.EqualFold(strings.TrimSpace(channel.Protocol), "otuapi") {
		return true
	}
	base := strings.ToLower(strings.TrimSpace(channel.BaseURL))
	if base == "" {
		return false
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Host == "" {
		return strings.Contains(base, "otuapi.com")
	}
	host := strings.TrimPrefix(parsed.Hostname(), "www.")
	return host == "otuapi.com"
}

func OtuapiProxyRequest(channel model.ModelChannel, path string, body []byte, contentType string) OtuapiProxyResult {
	if !IsOtuapiChannel(channel) {
		return OtuapiProxyResult{}
	}
	if path == "/responses" {
		responseBody, responseType, err := otuapiResponsesViaChatCompletions(channel, body)
		return OtuapiProxyResult{Handled: true, Body: responseBody, ContentType: responseType, Err: err}
	}
	return OtuapiProxyResult{}
}

func OtuapiProxyPath(channel model.ModelChannel, modelName string, path string) string {
	if !IsOtuapiChannel(channel) {
		return path
	}
	model := strings.ToLower(strings.TrimSpace(modelName))
	if path == "/images/generations" && otuapiAsyncImageModel(model) {
		return "/videos"
	}
	if path == "/videos" && (otuapiAsyncImageModel(model) || otuapiVideoModel(model)) {
		return "/videos"
	}
	return path
}

func OtuapiNormalizeJSONRequest(channel model.ModelChannel, modelName string, path string, body []byte, contentType string) ([]byte, string) {
	if !IsOtuapiChannel(channel) || !strings.HasPrefix(strings.ToLower(contentType), "application/json") {
		return body, contentType
	}
	model := strings.ToLower(strings.TrimSpace(modelName))
	if otuapiVideoCreatePath(path) && (otuapiAsyncImageModel(model) || otuapiVideoModel(model)) {
		if normalized, ok := otuapiNormalizeVideoJSONBody(model, body); ok {
			return normalized, contentType
		}
	}
	return body, contentType
}

func OtuapiNormalizeFormRequest(channel model.ModelChannel, modelName string, path string, body []byte, contentType string) ([]byte, string) {
	if !IsOtuapiChannel(channel) || !strings.HasPrefix(strings.ToLower(contentType), "multipart/form-data") {
		return body, contentType
	}
	model := strings.ToLower(strings.TrimSpace(modelName))
	if otuapiVideoCreatePath(path) && otuapiVideoModel(model) {
		if normalized, normalizedContentType, ok := otuapiNormalizeVideoFormBody(body, contentType); ok {
			return normalized, normalizedContentType
		}
	}
	return body, contentType
}

func otuapiVideoCreatePath(path string) bool {
	return path == "/videos" || path == "/videos/"
}

func OtuapiUsesBearerAuth(channel model.ModelChannel) bool {
	return IsOtuapiChannel(channel)
}

func OtuapiUsesGeminiNativeImage(channel model.ModelChannel, modelName string, path string) bool {
	if !IsOtuapiChannel(channel) || path != "/images/generations" {
		return false
	}
	model := strings.ToLower(strings.TrimSpace(modelName))
	return strings.Contains(model, "gemini") && strings.Contains(model, "image-preview")
}

func OtuapiTestModel(channel model.ModelChannel, modelName string) (string, bool, error) {
	if !IsOtuapiChannel(channel) {
		return "", false, nil
	}
	model := strings.ToLower(strings.TrimSpace(modelName))
	if strings.TrimSpace(modelName) == "" {
		return "", true, safeMessageError{message: "缺少模型名称"}
	}
	if otuapiAsyncImageModel(model) {
		return "章鱼哥异步图片模型配置格式已检查；后台不会调用 /v1/videos 生成任务，请到生图功能中实测。", true, nil
	}
	if strings.Contains(model, "gemini") && strings.Contains(model, "image-preview") {
		return "章鱼哥 Gemini 原生图片模型配置格式已检查；后台不会调用 generateContent 生成图片，请到生图功能中实测。", true, nil
	}
	if model == "image2" || strings.Contains(model, "image-preview") {
		return "章鱼哥同步图片模型配置格式已检查；后台不会调用 /v1/images/generations 生成图片，请到生图功能中实测。", true, nil
	}
	if otuapiVideoModel(model) {
		return "章鱼哥视频模型配置格式已检查；后台不会调用 /v1/videos 生成任务，请到视频功能中实测。", true, nil
	}
	return "", false, nil
}

func otuapiResponsesViaChatCompletions(channel model.ModelChannel, body []byte) ([]byte, string, error) {
	var responsesRequest otuapiResponsesRequest
	if err := json.Unmarshal(body, &responsesRequest); err != nil {
		return nil, "", safeMessageError{message: "Responses 请求解析失败"}
	}
	chatRequest, err := otuapiChatRequestFromResponses(responsesRequest)
	if err != nil {
		return nil, "", err
	}
	requestBody, _ := json.Marshal(chatRequest)
	request, err := http.NewRequest(http.MethodPost, BuildModelChannelURL(channel, "/chat/completions"), bytes.NewReader(requestBody))
	if err != nil {
		return nil, "", err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := otuapiModelHTTPClient.Do(request)
	if err != nil {
		if isTimeoutError(err) {
			return nil, "", safeMessageError{message: "章鱼哥 AI 上游模型长时间没有响应，请检查该模型在章鱼哥后台是否可用，或切换其他文本模型重试"}
		}
		return nil, "", safeMessageError{message: "章鱼哥 AI 接口无响应或网络不可达"}
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		return nil, "", readAdminChannelError(responseBody, response.StatusCode, "章鱼哥 AI 请求失败")
	}
	payload, content, err := otuapiResponsesPayloadFromChat(responseBody, responsesRequest.Model)
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

func isTimeoutError(err error) bool {
	if err == nil {
		return false
	}
	if netErr, ok := err.(interface{ Timeout() bool }); ok && netErr.Timeout() {
		return true
	}
	return err == context.DeadlineExceeded
}

func otuapiChatRequestFromResponses(request otuapiResponsesRequest) (otuapiChatRequest, error) {
	messages := make([]otuapiChatMessage, 0, len(request.Input))
	for _, item := range request.Input {
		switch {
		case item.Type == "function_call":
			messages = append(messages, otuapiChatMessage{
				Role: "assistant",
				ToolCalls: []otuapiChatToolCall{{
					ID:   item.CallID,
					Type: "function",
					Function: otuapiChatToolFunction{
						Name:      item.Name,
						Arguments: item.Arguments,
					},
				}},
			})
		case item.Type == "function_call_output" || item.Role == "tool":
			output := item.Output
			if output == "" {
				output = stringValue(item.Content)
			}
			messages = append(messages, otuapiChatMessage{Role: "tool", ToolCallID: item.CallID, Content: output})
		case item.Role != "":
			messages = append(messages, otuapiChatMessage{Role: item.Role, Content: otuapiChatContent(item.Content)})
		}
	}
	tools := make([]otuapiChatTool, 0, len(request.Tools))
	for _, tool := range request.Tools {
		if strings.TrimSpace(tool.Name) != "" {
			tools = append(tools, otuapiChatTool{Type: "function", Function: otuapiChatToolFunction{Name: tool.Name, Description: tool.Description, Parameters: tool.Parameters, Strict: tool.Strict}})
			continue
		}
		if tool.Function != nil {
			tools = append(tools, otuapiChatTool{Type: "function", Function: otuapiChatToolFunction{Name: tool.Function.Name, Description: tool.Function.Description, Parameters: tool.Function.Parameters, Strict: tool.Function.Strict}})
		}
	}
	chat := otuapiChatRequest{
		Model:             request.Model,
		Messages:          messages,
		Tools:             tools,
		ToolChoice:        otuapiChatToolChoice(request.ToolChoice),
		ParallelToolCalls: request.ParallelToolCalls,
		Stream:            false,
		Temperature:       request.Temperature,
		TopP:              request.TopP,
		MaxTokens:          request.MaxOutputTokens,
	}
	if strings.TrimSpace(chat.Model) == "" {
		return chat, safeMessageError{message: "缺少模型名称"}
	}
	if len(chat.Messages) == 0 {
		return chat, safeMessageError{message: "缺少对话内容"}
	}
	return chat, nil
}

func otuapiChatContent(content any) any {
	items, ok := content.([]interface{})
	if !ok {
		return content
	}
	result := make([]map[string]interface{}, 0, len(items))
	for _, raw := range items {
		item, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		switch item["type"] {
		case "input_text":
			result = append(result, map[string]interface{}{"type": "text", "text": item["text"]})
		case "input_image":
			result = append(result, map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": item["image_url"]}})
		}
	}
	if len(result) == 0 {
		return content
	}
	return result
}

func otuapiChatToolChoice(value any) any {
	if text, ok := value.(string); ok {
		if text == "required" {
			return "required"
		}
		return text
	}
	if item, ok := value.(map[string]interface{}); ok {
		if item["type"] == "function" {
			if name, ok := item["name"].(string); ok {
				return map[string]interface{}{"type": "function", "function": map[string]interface{}{"name": name}}
			}
		}
	}
	return value
}

func otuapiResponsesPayloadFromChat(body []byte, fallbackModel string) (otuapiResponsePayload, string, error) {
	var chat otuapiChatResponse
	if err := json.Unmarshal(body, &chat); err != nil {
		return otuapiResponsePayload{}, "", safeMessageError{message: "章鱼哥 AI 响应解析失败"}
	}
	if chat.Error != nil && strings.TrimSpace(chat.Error.Message) != "" {
		return otuapiResponsePayload{}, "", safeMessageError{message: chat.Error.Message}
	}
	output := []map[string]interface{}{}
	outputText := ""
	if len(chat.Choices) > 0 {
		message := chat.Choices[0].Message
		outputText = otuapiContentText(message.Content)
		if outputText != "" {
			output = append(output, map[string]interface{}{
				"type":    "message",
				"content": []map[string]string{{"type": "output_text", "text": outputText}},
			})
		}
		for _, call := range message.ToolCalls {
			output = append(output, map[string]interface{}{
				"type":      "function_call",
				"id":        call.ID,
				"call_id":   call.ID,
				"name":      call.Function.Name,
				"arguments": call.Function.Arguments,
			})
		}
	}
	modelName := chat.Model
	if modelName == "" {
		modelName = fallbackModel
	}
	return otuapiResponsePayload{ID: chat.ID, Object: "response", Model: modelName, Output: output, OutputText: outputText}, outputText, nil
}

func otuapiContentText(content any) string {
	switch value := content.(type) {
	case string:
		return value
	case []interface{}:
		texts := []string{}
		for _, raw := range value {
			if item, ok := raw.(map[string]interface{}); ok {
				if text := stringValue(item["text"]); text != "" {
					texts = append(texts, text)
				}
			}
		}
		return strings.Join(texts, "")
	default:
		if content == nil {
			return ""
		}
		encoded, _ := json.Marshal(content)
		return string(encoded)
	}
}

func stringValue(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func otuapiAsyncImageModel(model string) bool {
	return model == "gpt-image-2" || strings.HasPrefix(model, "gpt-image-2-") || model == "nano_banana_2" || strings.HasPrefix(model, "nano_banana_pro")
}

func otuapiVideoModel(model string) bool {
	return strings.Contains(model, "sora") || strings.Contains(model, "veo") || strings.Contains(model, "omni")
}

func otuapiNormalizeVideoJSONBody(model string, body []byte) ([]byte, bool) {
	var payload map[string]interface{}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, false
	}
	changed := false
	if size := stringValue(payload["size"]); size != "" {
		if ratio := otuapiAspectRatioFromSize(size); ratio != "" && otuapiAsyncImageModel(model) {
			payload["aspect_ratio"] = ratio
			delete(payload, "size")
			changed = true
		}
	}
	if _, ok := payload["images"]; !ok {
		if imageValue, ok := payload["image"]; ok {
			payload["images"] = otuapiImagesArray(imageValue)
			delete(payload, "image")
			changed = true
		}
	}
	if !changed {
		return nil, false
	}
	normalized, _ := json.Marshal(payload)
	return normalized, true
}

func otuapiNormalizeVideoFormBody(body []byte, contentType string) ([]byte, string, bool) {
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil || !strings.HasPrefix(strings.ToLower(mediaType), "multipart/form-data") {
		return nil, "", false
	}
	reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	form, err := reader.ReadForm(128 << 20)
	if err != nil {
		return nil, "", false
	}
	defer form.RemoveAll()
	changed := false
	if values := form.File["input_reference[]"]; len(values) > 0 {
		form.File["input_reference"] = append(form.File["input_reference"], values...)
		delete(form.File, "input_reference[]")
		changed = true
	}
	if values := form.Value["input_reference[]"]; len(values) > 0 {
		form.Value["input_reference"] = append(form.Value["input_reference"], values...)
		delete(form.Value, "input_reference[]")
		changed = true
	}
	if !changed {
		return nil, "", false
	}
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	for key, values := range form.Value {
		for _, value := range values {
			_ = writer.WriteField(key, value)
		}
	}
	for key, files := range form.File {
		for _, fileHeader := range files {
			file, err := fileHeader.Open()
			if err != nil {
				continue
			}
			part, err := writer.CreateFormFile(key, fileHeader.Filename)
			if err == nil {
				_, _ = io.Copy(part, file)
			}
			_ = file.Close()
		}
	}
	_ = writer.Close()
	return buffer.Bytes(), writer.FormDataContentType(), true
}

func otuapiImagesArray(value interface{}) []interface{} {
	switch item := value.(type) {
	case []interface{}:
		return item
	case string:
		if strings.TrimSpace(item) == "" {
			return nil
		}
		return []interface{}{item}
	default:
		return nil
	}
}

func otuapiAspectRatioFromSize(size string) string {
	value := strings.TrimSpace(size)
	if value == "" || value == "auto" {
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

func parsePositiveInt(value string) int {
	total := 0
	for _, r := range strings.TrimSpace(value) {
		if r < '0' || r > '9' {
			return 0
		}
		total = total*10 + int(r-'0')
	}
	return total
}

func reduceRatio(width int, height int) string {
	divisor := gcd(width, height)
	return strconv.Itoa(width/divisor) + ":" + strconv.Itoa(height/divisor)
}

func gcd(a int, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	if a < 0 {
		return -a
	}
	if a == 0 {
		return 1
	}
	return a
}
