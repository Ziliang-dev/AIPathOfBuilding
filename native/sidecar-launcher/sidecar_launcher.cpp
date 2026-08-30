#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>

#include <string>

namespace {

std::wstring QuoteArgument(const std::wstring& value) {
    if (value.empty()) return L"\"\"";
    if (value.find_first_of(L" \t\"") == std::wstring::npos) return value;
    std::wstring quoted = L"\"";
    size_t backslashes = 0;
    for (const wchar_t character : value) {
        if (character == L'\\') {
            ++backslashes;
            continue;
        }
        if (character == L'\"') {
            quoted.append(backslashes * 2 + 1, L'\\');
            quoted.push_back(character);
            backslashes = 0;
            continue;
        }
        quoted.append(backslashes, L'\\');
        backslashes = 0;
        quoted.push_back(character);
    }
    quoted.append(backslashes * 2, L'\\');
    quoted.push_back(L'\"');
    return quoted;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    int argumentCount = 0;
    LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
    if (arguments == nullptr) return static_cast<int>(GetLastError());
    if (argumentCount < 2 || arguments[1][0] == L'\0') {
        LocalFree(arguments);
        return ERROR_BAD_ARGUMENTS;
    }

    const std::wstring executable(arguments[1]);
    std::wstring commandLine;
    for (int index = 1; index < argumentCount; ++index) {
        if (!commandLine.empty()) commandLine.push_back(L' ');
        commandLine.append(QuoteArgument(arguments[index]));
    }
    LocalFree(arguments);

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    const DWORD flags = CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT;
    const BOOL created = CreateProcessW(
        executable.c_str(),
        commandLine.data(),
        nullptr,
        nullptr,
        FALSE,
        flags,
        nullptr,
        nullptr,
        &startup,
        &process
    );
    if (!created) return static_cast<int>(GetLastError());
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return 0;
}
