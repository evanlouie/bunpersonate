#include <curl/curl.h>

CURLcode curl_easy_setopt_long_shim(CURL *handle, CURLoption option, long value) {
  return curl_easy_setopt(handle, option, value);
}

CURLcode curl_easy_setopt_ptr_shim(CURL *handle, CURLoption option, const void *value) {
  return curl_easy_setopt(handle, option, value);
}

CURLcode curl_easy_getinfo_long_shim(CURL *handle, CURLINFO info, long *out) {
  return curl_easy_getinfo(handle, info, out);
}

CURLcode curl_easy_getinfo_ptr_shim(CURL *handle, CURLINFO info, void **out) {
  return curl_easy_getinfo(handle, info, out);
}
