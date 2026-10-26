#import <AppKit/AppKit.h>
#import <Sparkle/Sparkle.h>
#include <node_api.h>
#include <atomic>
#include <initializer_list>
#include <string>

struct BridgeContext;

@interface GSSparkleBridge : NSObject <SPUUserDriver, SPUUpdaterDelegate>
@property(nonatomic, assign) BridgeContext *context;
@property(nonatomic, strong) SPUUpdater *updater;
@property(nonatomic, copy) NSString *feedURL;
@property(nonatomic, copy) NSString *phase;
@property(nonatomic, copy) void (^choiceReply)(SPUUserUpdateChoice);
@property(nonatomic, copy) void (^readyReply)(SPUUserUpdateChoice);
@property(nonatomic, copy) void (^cancellation)(void);
@property(nonatomic, strong) NSMutableArray<NSValue *> *cancelWaiters;
@property(nonatomic) BOOL cancelRequested;
@property(nonatomic) BOOL installationCommitted;
@property(nonatomic) BOOL informationOnly;
@property(nonatomic) BOOL installationPrepared;
@property(nonatomic) BOOL installerMayBeArmed;
@property(nonatomic) uint64_t receivedBytes;
@property(nonatomic) uint64_t expectedBytes;
- (void)emit:(NSString *)type fields:(NSDictionary *)fields;
- (void)attemptCancel;
@end

struct BridgePayload {
  NSDictionary *__strong value;
  napi_deferred deferred;
  bool rejected;
};

struct BridgeContext {
  napi_env env = nullptr;
  napi_threadsafe_function channel = nullptr;
  napi_ref handler = nullptr;
  std::atomic<bool> closing{false};
  GSSparkleBridge *__strong driver = nil;
};

static napi_value JSValue(napi_env env, id value) {
  napi_value result;
  if (value == nil || value == NSNull.null) {
    napi_get_null(env, &result);
  } else if ([value isKindOfClass:NSString.class]) {
    napi_create_string_utf8(env, [value UTF8String], NAPI_AUTO_LENGTH, &result);
  } else if ([value isKindOfClass:NSNumber.class]) {
    if (CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) {
      napi_get_boolean(env, [value boolValue], &result);
    } else {
      napi_create_double(env, [value doubleValue], &result);
    }
  } else if ([value isKindOfClass:NSArray.class]) {
    napi_create_array_with_length(env, [value count], &result);
    uint32_t index = 0;
    for (id child in value) napi_set_element(env, result, index++, JSValue(env, child));
  } else {
    napi_create_object(env, &result);
    for (NSString *key in value) {
      napi_set_named_property(env, result, key.UTF8String, JSValue(env, value[key]));
    }
  }
  return result;
}

static void CallJS(napi_env env, napi_value callback, void *rawContext, void *rawPayload) {
  BridgePayload *payload = static_cast<BridgePayload *>(rawPayload);
  if (env != nullptr) {
    BridgeContext *context = static_cast<BridgeContext *>(rawContext);
    napi_value value = JSValue(env, payload->value);
    if (payload->deferred != nullptr) {
      if (payload->rejected) {
        napi_value message, error;
        napi_create_string_utf8(env, [payload->value[@"message"] UTF8String], NAPI_AUTO_LENGTH, &message);
        napi_create_error(env, nullptr, message, &error);
        napi_set_named_property(env, error, "details", value);
        napi_reject_deferred(env, payload->deferred, error);
      } else {
        napi_resolve_deferred(env, payload->deferred, value);
      }
    } else if (!context->closing && context->handler != nullptr) {
      napi_value handler, global, ignored;
      napi_get_reference_value(env, context->handler, &handler);
      napi_get_global(env, &global);
      napi_status status = napi_call_function(env, global, handler, 1, &value, &ignored);
      if (status == napi_pending_exception) {
        napi_value error;
        napi_get_and_clear_last_exception(env, &error);
        napi_fatal_exception(env, error);
      }
    }
  }
  delete payload;
}

static void Send(BridgeContext *context, NSDictionary *value, napi_deferred deferred = nullptr, bool rejected = false) {
  if (context == nullptr || context->closing) return;
  auto *payload = new BridgePayload{value, deferred, rejected};
  if (napi_call_threadsafe_function(context->channel, payload, napi_tsfn_nonblocking) != napi_ok) delete payload;
}

static NSDictionary *ErrorFieldsAtDepth(NSError *error, NSUInteger depth) {
  NSMutableDictionary *fields = [NSMutableDictionary dictionaryWithDictionary:@{@"message": error.localizedDescription ?: @"Sparkle error",
           @"domain": error.domain ?: @"", @"code": @(error.code)}];
  if (error.localizedFailureReason) fields[@"failureReason"] = error.localizedFailureReason;
  if (error.localizedRecoverySuggestion) fields[@"recoverySuggestion"] = error.localizedRecoverySuggestion;
  NSError *underlying = error.userInfo[NSUnderlyingErrorKey];
  if (underlying && depth < 4) fields[@"underlyingError"] = ErrorFieldsAtDepth(underlying, depth + 1);
  return fields;
}
static NSDictionary *ErrorFields(NSError *error) { return ErrorFieldsAtDepth(error, 0); }


@implementation GSSparkleBridge
- (instancetype)init {
  self = [super init];
  if (self) {
    _phase = @"idle";
    _cancelWaiters = [NSMutableArray array];
  }
  return self;
}
- (void)emit:(NSString *)type fields:(NSDictionary *)fields {
  NSMutableDictionary *event = [NSMutableDictionary dictionaryWithDictionary:fields ?: @{}];
  event[@"type"] = type;
  event[@"phase"] = self.phase;
  event[@"installerMayBeArmed"] = @(self.installerMayBeArmed);
  event[@"installationCommitted"] = @(self.installationCommitted);
  Send(self.context, event);
}
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater { return self.feedURL; }
- (BOOL)updaterShouldPromptForPermissionToCheckForUpdates:(SPUUpdater *)updater { return NO; }
- (BOOL)updater:(SPUUpdater *)updater shouldDownloadReleaseNotesForUpdate:(SUAppcastItem *)item { return NO; }
- (BOOL)updater:(SPUUpdater *)updater mayPerformUpdateCheck:(SPUUpdateCheck)check error:(NSError **)error {
  if (check != SPUUpdateCheckUpdatesInBackground) return YES;
  if (error) *error = [NSError errorWithDomain:@"GuziSparkleBridge" code:1 userInfo:@{NSLocalizedDescriptionKey: @"Background update cycles are disabled in this bridge."}];
  return NO;
}
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
  reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO automaticUpdateDownloading:@NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation {
  self.phase = @"checking";
  self.cancellation = cancellation;
  [self emit:@"checking" fields:nil];
  [self attemptCancel];
}
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
  self.cancellation = nil;
  self.choiceReply = reply;
  self.informationOnly = item.informationOnlyUpdate;
  self.installerMayBeArmed = state.stage == SPUUserUpdateStageInstalling;
  self.installationPrepared = self.installerMayBeArmed;
  self.phase = self.installerMayBeArmed ? @"resuming-installation" : @"available";
  NSDictionary *enclosure = item.propertiesDictionary[@"enclosure"];
  [self emit:@"available" fields:@{@"version": item.versionString ?: @"",
    @"displayVersion": item.displayVersionString ?: @"", @"stage": @(state.stage),
    @"informationOnly": @(item.informationOnlyUpdate), @"fileURL": item.fileURL.absoluteString ?: @"",
    @"downloadURL": item.fileURL.absoluteString ?: @"", @"length": @(item.contentLength),
    @"signature": enclosure[@"sparkle:edSignature"] ?: @""}];
  [self attemptCancel];
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)downloadData {}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {
  [self emit:@"release-notes-error" fields:ErrorFields(error)];
}
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
  [self emit:@"not-available" fields:ErrorFields(error)];
  acknowledgement();
}
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
  self.phase = @"error";
  [self emit:@"error" fields:ErrorFields(error)];
  acknowledgement();
}
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation {
  self.phase = @"downloading";
  self.receivedBytes = 0;
  self.expectedBytes = 0;
  self.cancellation = cancellation;
  [self emit:@"download-started" fields:nil];
  [self attemptCancel];
}
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)length {
  self.expectedBytes = length;
  [self emit:@"download-progress" fields:@{@"receivedBytes": @(self.receivedBytes), @"expectedBytes": @(length)}];
}
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {
  self.receivedBytes += length;
  [self emit:@"download-progress" fields:@{@"receivedBytes": @(self.receivedBytes), @"expectedBytes": @(self.expectedBytes)}];
}
- (void)updater:(SPUUpdater *)updater didDownloadUpdate:(SUAppcastItem *)item {
  [self emit:@"downloaded" fields:@{@"version": item.versionString ?: @"", @"installationCycleContinues": @YES}];
}
- (void)showDownloadDidStartExtractingUpdate {
  self.cancellation = nil;
  self.installerMayBeArmed = YES;
  self.phase = @"extracting";
  [self emit:@"extracting" fields:nil];
}
- (void)showExtractionReceivedProgress:(double)progress {
  [self emit:@"extraction-progress" fields:@{@"progress": @(progress)}];
}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
  self.readyReply = reply;
  self.installationPrepared = YES;
  self.installerMayBeArmed = YES;
  self.phase = @"ready";
  [self emit:@"ready" fields:@{@"installOnQuitPossible": @YES}];
  [self attemptCancel];
}
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)terminated retryTerminatingApplication:(void (^)(void))retry {
  self.phase = @"installing";
  [self emit:@"installing" fields:@{@"applicationTerminated": @(terminated)}];
}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))acknowledgement {
  self.phase = @"installed";
  [self emit:@"installed" fields:@{@"relaunched": @(relaunched)}];
  acknowledgement();
}
- (void)dismissUpdateInstallation {
  self.choiceReply = nil;
  self.readyReply = nil;
  self.cancellation = nil;
  [self emit:@"dismissed" fields:nil];
}
- (void)showUpdateInFocus { [self emit:@"focus" fields:nil]; }
- (void)attemptCancel {
  if (!self.cancelRequested) return;
  if (self.readyReply) {
    void (^reply)(SPUUserUpdateChoice) = self.readyReply;
    self.readyReply = nil;
    reply(SPUUserUpdateChoiceSkip);
  } else if (self.choiceReply) {
    void (^reply)(SPUUserUpdateChoice) = self.choiceReply;
    self.choiceReply = nil;
    reply(self.installerMayBeArmed ? SPUUserUpdateChoiceSkip : SPUUserUpdateChoiceDismiss);
  } else if (self.cancellation) {
    void (^cancellation)(void) = self.cancellation;
    self.cancellation = nil;
    cancellation();
  }
}
- (void)updater:(SPUUpdater *)updater didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)check error:(NSError *)error {
  self.choiceReply = nil;
  self.readyReply = nil;
  self.cancellation = nil;
  self.phase = @"idle";
  // A failed preparation never reached Sparkle's install-on-quit state.
  if (error && !self.installationPrepared && !self.installationCommitted) self.installerMayBeArmed = NO;
  NSDictionary *result = @{@"cycleFinished": @YES, @"cancelRequested": @(self.cancelRequested),
    @"externalInstallerAcknowledged": @NO, @"installerMayBeArmed": @(self.installerMayBeArmed),
    @"error": error ? ErrorFields(error) : (id)NSNull.null};
  [self emit:@"cycle-finished" fields:result];
  for (NSValue *waiter in self.cancelWaiters) Send(self.context, result, static_cast<napi_deferred>(waiter.pointerValue));
  [self.cancelWaiters removeAllObjects];
  self.cancelRequested = NO;
}
@end

static BridgeContext *Context(napi_env env) {
  BridgeContext *context = nullptr;
  napi_get_instance_data(env, reinterpret_cast<void **>(&context));
  return context;
}

static NSString *StringOption(napi_env env, napi_value object, const char *name) {
  bool has = false;
  napi_has_named_property(env, object, name, &has);
  if (!has) return nil;
  napi_value value;
  napi_get_named_property(env, object, name, &value);
  napi_valuetype type;
  napi_typeof(env, value, &type);
  if (type != napi_string) return nil;
  size_t length;
  napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  std::string buffer(length + 1, '\0');
  napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length);
  return [[NSString alloc] initWithBytes:buffer.data() length:length encoding:NSUTF8StringEncoding];
}

static napi_value Command(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  void *rawName;
  napi_get_cb_info(env, info, &argc, argv, nullptr, &rawName);
  NSString *name = [NSString stringWithUTF8String:static_cast<const char *>(rawName)];
  BridgeContext *context = Context(env);
  napi_deferred deferred;
  napi_value promise;
  napi_create_promise(env, &deferred, &promise);
  auto fail = [&](NSString *message) { Send(context, @{@"message": message}, deferred, true); };
  if (![NSThread isMainThread]) {
    fail(@"Load and call this bridge from the Electron main process on the macOS main thread.");
    return promise;
  }
  if ([name isEqualToString:@"init"]) {
    if (context->driver) { fail(@"Sparkle bridge is already initialized."); return promise; }
    napi_valuetype type = napi_undefined;
    if (argc) napi_typeof(env, argv[0], &type);
    if (type != napi_object) { fail(@"init requires an options object."); return promise; }
    NSString *feed = StringOption(env, argv[0], "feedURL");
    NSURL *url = feed ? [NSURL URLWithString:feed] : nil;
    if (!url.host.length || ![@[@"https", @"http"] containsObject:url.scheme.lowercaseString]) {
      fail(@"init requires an absolute http(s) feedURL."); return promise;
    }
    NSBundle *bundle = NSBundle.mainBundle;
    NSString *hostPath = StringOption(env, argv[0], "hostBundle");
    if (hostPath && ![hostPath.stringByResolvingSymlinksInPath isEqualToString:bundle.bundlePath.stringByResolvingSymlinksInPath]) {
      fail(@"This bridge only updates its current running application bundle."); return promise;
    }
    NSString *publicKey = [bundle objectForInfoDictionaryKey:@"SUPublicEDKey"];
    NSString *expectedKey = StringOption(env, argv[0], "publicKey");
    if (![bundle.bundlePath.pathExtension isEqualToString:@"app"] || publicKey.length == 0 ||
        (expectedKey && ![expectedKey isEqualToString:publicKey])) {
      fail(@"Run inside a test .app with SUPublicEDKey in Info.plist matching the optional publicKey."); return promise;
    }
    GSSparkleBridge *driver = [GSSparkleBridge new];
    driver.context = context;
    driver.feedURL = feed;
    driver.updater = [[SPUUpdater alloc] initWithHostBundle:bundle applicationBundle:bundle userDriver:driver delegate:driver];
    driver.updater.automaticallyChecksForUpdates = NO;
    driver.updater.automaticallyDownloadsUpdates = NO;
    NSError *error;
    if (![driver.updater startUpdater:&error]) {
      driver.context = nullptr;
      driver.updater = nil;
      Send(context, ErrorFields(error), deferred, true);
      return promise;
    }
    context->driver = driver;
    Send(context, @{@"initialized": @YES, @"feedURL": feed, @"hostBundle": bundle.bundlePath,
      @"cancelHasExternalAcknowledgement": @NO}, deferred);
    return promise;
  }
  GSSparkleBridge *driver = context->driver;
  if (!driver) { fail(@"Call init before updater commands."); return promise; }
  if ([name isEqualToString:@"setFeedURL"]) {
    if (driver.updater.sessionInProgress || driver.cancelRequested || driver.installerMayBeArmed) {
      fail(@"setFeedURL requires an idle bridge with no possibly armed installer."); return promise;
    }
    size_t length = 0;
    napi_valuetype type = napi_undefined;
    if (argc) napi_typeof(env, argv[0], &type);
    if (type != napi_string) { fail(@"setFeedURL requires an absolute feed URL string."); return promise; }
    napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length);
    std::string buffer(length + 1, '\0');
    napi_get_value_string_utf8(env, argv[0], buffer.data(), buffer.size(), &length);
    NSString *feed = [[NSString alloc] initWithBytes:buffer.data() length:length encoding:NSUTF8StringEncoding];
    NSURL *url = [NSURL URLWithString:feed];
    if (!url.host.length || ![@[@"https", @"http"] containsObject:url.scheme.lowercaseString]) {
      fail(@"setFeedURL requires an absolute http(s) feed URL."); return promise;
    }
    driver.feedURL = feed;
  } else if ([name isEqualToString:@"check"]) {
    if (driver.updater.sessionInProgress || driver.cancelRequested) { fail(@"An update cycle is already in progress."); return promise; }
    driver.installationCommitted = NO;
    driver.installationPrepared = NO;
    [driver.updater checkForUpdates];
  } else if ([name isEqualToString:@"download"]) {
    if (!driver.choiceReply || driver.informationOnly || driver.installerMayBeArmed || driver.cancelRequested) {
      fail(@"download requires an available, not-yet-installing archive update."); return promise;
    }
    void (^reply)(SPUUserUpdateChoice) = driver.choiceReply;
    driver.choiceReply = nil;
    driver.cancellation = nil;
    reply(SPUUserUpdateChoiceInstall);
  } else if ([name isEqualToString:@"install"]) {
    if (!driver.readyReply || driver.cancelRequested) { fail(@"install requires the ready event and no pending cancel."); return promise; }
    driver.installationCommitted = YES;
    void (^reply)(SPUUserUpdateChoice) = driver.readyReply;
    driver.readyReply = nil;
    reply(SPUUserUpdateChoiceInstall);
  } else if ([name isEqualToString:@"cancel"]) {
    if (driver.installationCommitted) { fail(@"Cannot cancel after explicit install has been committed."); return promise; }
    if (!driver.updater.sessionInProgress) {
      Send(context, @{@"cycleFinished": @YES, @"externalInstallerAcknowledged": @NO,
        @"installerMayBeArmed": @(driver.installerMayBeArmed)}, deferred);
      return promise;
    }
    driver.cancelRequested = YES;
    [driver.cancelWaiters addObject:[NSValue valueWithPointer:deferred]];
    [driver emit:@"cancel-requested" fields:@{@"externalInstallerAcknowledged": @NO}];
    [driver attemptCancel];
    return promise;
  }
  Send(context, @{@"accepted": @YES, @"command": name}, deferred);
  return promise;
}

static napi_value SetEventHandler(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value callback;
  napi_get_cb_info(env, info, &argc, &callback, nullptr, nullptr);
  napi_valuetype type = napi_undefined;
  if (argc) napi_typeof(env, callback, &type);
  if (type != napi_function) {
    napi_throw_type_error(env, nullptr, "setEventHandler requires a function.");
    return nullptr;
  }
  BridgeContext *context = Context(env);
  if (context->handler) napi_delete_reference(env, context->handler);
  napi_create_reference(env, callback, 1, &context->handler);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static void FinalizeChannel(napi_env env, void *data, void *hint) {
  BridgeContext *context = static_cast<BridgeContext *>(data);
  context->driver.context = nullptr;
  context->driver.updater = nil;
  context->driver = nil;
  delete context;
}

static void CleanupEnvironment(void *data) {
  BridgeContext *context = static_cast<BridgeContext *>(data);
  context->closing = true;
  context->driver.context = nullptr;
  context->driver.updater = nil;
  context->driver = nil;
  if (context->handler) {
    napi_delete_reference(context->env, context->handler);
    context->handler = nullptr;
  }
  napi_release_threadsafe_function(context->channel, napi_tsfn_abort);
}

static napi_value Initialize(napi_env env, napi_value exports) {
  auto *context = new BridgeContext;
  context->env = env;
  napi_value resourceName;
  napi_create_string_utf8(env, "GuziSparkleBridge", NAPI_AUTO_LENGTH, &resourceName);
  napi_create_threadsafe_function(env, nullptr, nullptr, resourceName, 0, 1, context,
    FinalizeChannel, context, CallJS, &context->channel);
  napi_unref_threadsafe_function(env, context->channel);
  napi_set_instance_data(env, context, nullptr, nullptr);
  napi_add_env_cleanup_hook(env, CleanupEnvironment, context);
  for (const char *name : {"init", "setFeedURL", "check", "download", "install", "cancel"}) {
    napi_value function;
    napi_create_function(env, name, NAPI_AUTO_LENGTH, Command, const_cast<char *>(name), &function);
    napi_set_named_property(env, exports, name, function);
  }
  napi_value handler;
  napi_create_function(env, "setEventHandler", NAPI_AUTO_LENGTH, SetEventHandler, nullptr, &handler);
  napi_set_named_property(env, exports, "setEventHandler", handler);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
