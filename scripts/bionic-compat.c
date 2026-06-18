/*
 * bionic-compat.so: provides glibc/musl symbols missing from Android bionic,
 * so that linuxmusl-arm64/runtime.node can be dlopen'd on Termux.
 * Load as LD_PRELOAD before Node.js.
 */
#define _GNU_SOURCE
#include <string.h>
#include <stdlib.h>
#include <errno.h>
#include <spawn.h>
#include <stddef.h>
#include <unistd.h>
#include <dlfcn.h>
#include <math.h>

/* bionic exports __errno() instead of __errno_location() */
extern int *__errno(void);
int *__errno_location(void) { return __errno(); }

int bcmp(const void *s1, const void *s2, size_t n) { return memcmp(s1, s2, n); }

/* jemalloc sized dealloc - bionic uses scudo, delegate to free */
void sdallocx(void *ptr, size_t size, int flags) {
    (void)size; (void)flags;
    free(ptr);
}

/* XSI strerror_r (int-returning); bionic's strerror_r returns char* */
int __xpg_strerror_r(int errnum, char *buf, size_t buflen) {
    const char *s = strerror(errnum);
    if (!s) { *__errno() = EINVAL; return EINVAL; }
    size_t len = strlen(s);
    if (len >= buflen) { *__errno() = ERANGE; return ERANGE; }
    memcpy(buf, s, len + 1);
    return 0;
}

/* pidfd APIs absent from this Android kernel version */
int pidfd_getpid(int fd) { (void)fd; *__errno() = ENOSYS; return -1; }

int pidfd_spawnp(int *pidfd,
                 const char *path,
                 const posix_spawn_file_actions_t *fa,
                 const posix_spawnattr_t *attr,
                 char *const argv[],
                 char *const envp[]) {
    (void)pidfd; (void)path; (void)fa; (void)attr; (void)argv; (void)envp;
    *__errno() = ENOSYS;
    return -1;
}

/* musl bundles math in libc.so; bionic splits to libm.so.
 * Since we are LD_PRELOAD, RTLD_NEXT finds the real libm.so symbols. */
typedef double (*fn_dd)(double);
typedef double (*fn_ddd)(double, double);
typedef float  (*fn_ff)(float);

static fn_ddd _pow;
static fn_dd  _log;
static fn_dd  _log2;
static fn_ff  _expf;
static fn_ff  _log10f;
static fn_ff  _sinf;

__attribute__((constructor))
static void compat_init(void) {
    _pow    = (fn_ddd)dlsym(RTLD_NEXT, "pow");
    _log    = (fn_dd) dlsym(RTLD_NEXT, "log");
    _log2   = (fn_dd) dlsym(RTLD_NEXT, "log2");
    _expf   = (fn_ff) dlsym(RTLD_NEXT, "expf");
    _log10f = (fn_ff) dlsym(RTLD_NEXT, "log10f");
    _sinf   = (fn_ff) dlsym(RTLD_NEXT, "sinf");
    /* NULL is expected in non-node processes (shells) that inherit LD_PRELOAD
     * but do not link libm.so. Those processes never invoke math stubs. */
}

double pow(double x, double y)   { if (!_pow)    abort(); return _pow(x, y); }
double log(double x)             { if (!_log)    abort(); return _log(x); }
double log2(double x)            { if (!_log2)   abort(); return _log2(x); }
float  expf(float x)             { if (!_expf)   abort(); return _expf(x); }
float  log10f(float x)           { if (!_log10f) abort(); return _log10f(x); }
float  sinf(float x)             { if (!_sinf)   abort(); return _sinf(x); }
