// AIPathOfBuilding WinCred helper.
// JSON-lines on stdin/stdout; no secrets are accepted as process arguments.
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <wincred.h>
#include <cctype>
#include <string>
#include <iostream>
#include <sstream>

static bool valid_target(const std::string& target) {
  const std::string prefix = "AIPathOfBuilding/LLM/";
  if (target.rfind(prefix, 0) != 0) return false;
  const std::string provider = target.substr(prefix.size());
  if (provider.empty() || provider.size() > 64) return false;
  const auto first = static_cast<unsigned char>(provider.front());
  if (!std::isalnum(first)) return false;
  for (const unsigned char c : provider) {
    if (!std::isalnum(c) && c != '.' && c != '_' && c != '-') return false;
  }
  return true;
}

static std::string json_escape(const std::string& value) {
  std::ostringstream out;
  for (unsigned char c : value) {
    switch (c) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\b': out << "\\b"; break;
      case '\f': out << "\\f"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (c < 0x20) {
          out << "\\u00" << "0123456789abcdef"[(c >> 4) & 0xf] << "0123456789abcdef"[c & 0xf];
        } else {
          out << c;
        }
    }
  }
  return out.str();
}

static bool json_string(const std::string& line, const std::string& key, std::string& result) {
  const std::string needle = "\"" + key + "\"";
  const std::size_t key_pos = line.find(needle);
  if (key_pos == std::string::npos) return false;
  std::size_t pos = line.find(':', key_pos + needle.size());
  if (pos == std::string::npos) return false;
  ++pos;
  while (pos < line.size() && (line[pos] == ' ' || line[pos] == '\t')) ++pos;
  if (pos >= line.size() || line[pos] != '"') return false;
  ++pos;
  std::ostringstream out;
  while (pos < line.size()) {
    const char c = line[pos++];
    if (c == '"') { result = out.str(); return true; }
    if (c != '\\') { out << c; continue; }
    if (pos >= line.size()) return false;
    const char escaped = line[pos++];
    switch (escaped) {
      case '"': out << '"'; break;
      case '\\': out << '\\'; break;
      case '/': out << '/'; break;
      case 'b': out << '\b'; break;
      case 'f': out << '\f'; break;
      case 'n': out << '\n'; break;
      case 'r': out << '\r'; break;
      case 't': out << '\t'; break;
      case 'u': {
        if (pos + 4 > line.size()) return false;
        unsigned int codepoint = 0;
        for (unsigned int index = 0; index < 4; ++index) {
          const char digit = line[pos++];
          codepoint <<= 4;
          if (digit >= '0' && digit <= '9') codepoint += static_cast<unsigned int>(digit - '0');
          else if (digit >= 'a' && digit <= 'f') codepoint += static_cast<unsigned int>(digit - 'a' + 10);
          else if (digit >= 'A' && digit <= 'F') codepoint += static_cast<unsigned int>(digit - 'A' + 10);
          else return false;
        }
        if (codepoint >= 0xd800 && codepoint <= 0xdfff) return false;
        if (codepoint < 0x80) out << static_cast<char>(codepoint);
        else if (codepoint < 0x800) {
          out << static_cast<char>(0xc0 | (codepoint >> 6));
          out << static_cast<char>(0x80 | (codepoint & 0x3f));
        } else {
          out << static_cast<char>(0xe0 | (codepoint >> 12));
          out << static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f));
          out << static_cast<char>(0x80 | (codepoint & 0x3f));
        }
        break;
      }
      default: return false;
    }
  }
  return false;
}

static std::wstring utf8_to_wide(const std::string& value) {
  if (value.empty()) return std::wstring();
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) return std::wstring();
  std::wstring output(static_cast<std::size_t>(length), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), output.data(), length);
  return output;
}

static std::string wide_to_utf8(const wchar_t* value, DWORD length) {
  if (value == nullptr || length == 0) return std::string();
  const int output_length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, static_cast<int>(length), nullptr, 0, nullptr, nullptr);
  if (output_length <= 0) return std::string();
  std::string output(static_cast<std::size_t>(output_length), '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, static_cast<int>(length), output.data(), output_length, nullptr, nullptr);
  return output;
}

static std::string error_response(const char* message) {
  return std::string("{\"ok\":false,\"error\":\"") + json_escape(message) + "\"}";
}

static std::string process(const std::string& line) {
  std::string op;
  std::string target;
  if (!json_string(line, "op", op) || !json_string(line, "target", target)) return error_response("Invalid request");
  if (!valid_target(target)) return error_response("Credential target is outside the AIPathOfBuilding LLM namespace");
  const std::wstring wide_target = utf8_to_wide(target);
  if (wide_target.empty()) return error_response("Invalid target");

  if (op == "get" || op == "has") {
    PCREDENTIALW credential = nullptr;
    if (!CredReadW(wide_target.c_str(), CRED_TYPE_GENERIC, 0, &credential)) {
      if (GetLastError() == ERROR_NOT_FOUND) return "{\"ok\":true,\"found\":false}";
      return error_response("Credential read failed");
    }
    if (op == "has") {
      CredFree(credential);
      return "{\"ok\":true,\"found\":true}";
    }
    std::string secret(reinterpret_cast<const char*>(credential->CredentialBlob), credential->CredentialBlobSize);
    if (credential->CredentialBlob != nullptr && credential->CredentialBlobSize > 0) {
      SecureZeroMemory(credential->CredentialBlob, credential->CredentialBlobSize);
    }
    CredFree(credential);
    std::string response = std::string("{\"ok\":true,\"found\":true,\"secret\":\"") + json_escape(secret) + "\"}";
    if (!secret.empty()) SecureZeroMemory(&secret[0], secret.size());
    return response;
  }

  if (op == "delete") {
    if (!CredDeleteW(wide_target.c_str(), CRED_TYPE_GENERIC, 0) && GetLastError() != ERROR_NOT_FOUND) {
      return error_response("Credential delete failed");
    }
    return "{\"ok\":true}";
  }

  if (op == "set") {
    std::string secret;
    if (!json_string(line, "secret", secret) || secret.empty()) return error_response("Invalid secret");
    CREDENTIALW credential = {};
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = const_cast<LPWSTR>(wide_target.c_str());
    credential.CredentialBlobSize = static_cast<DWORD>(secret.size());
    credential.CredentialBlob = reinterpret_cast<LPBYTE>(const_cast<char*>(secret.data()));
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    const BOOL wrote = CredWriteW(&credential, 0);
    if (!secret.empty()) SecureZeroMemory(&secret[0], secret.size());
    if (!wrote) return error_response("Credential write failed");
    return "{\"ok\":true}";
  }
  return error_response("Unsupported operation");
}

int wmain() {
  std::ios::sync_with_stdio(false);
  std::string line;
  while (std::getline(std::cin, line)) {
    std::string response = process(line);
    if (!line.empty()) SecureZeroMemory(&line[0], line.size());
    std::cout << response << std::endl;
    if (!response.empty()) SecureZeroMemory(&response[0], response.size());
  }
  return 0;
}
