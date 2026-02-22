/** @module omega-target/options */
import Log from './log';
import Storage from './storage';
import defaultOptions, { OmegaOptions } from './default_options';
import OptionsSync from './options_sync';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OmegaPac = require('omega-pac');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsondiffpatch = require('jsondiffpatch');

class ProfileNotExistError extends Error {
  profileName: string;
  constructor(profileName: string) {
    super(`Profile ${profileName} does not exist!`);
    this.profileName = profileName;
    this.name = 'ProfileNotExistError';
  }
}

class NoOptionsError extends Error {
  constructor() {
    super('No options found');
    this.name = 'NoOptionsError';
  }
}

class Options {
  static ProfileNotExistError = ProfileNotExistError;
  static NoOptionsError = NoOptionsError;

  _options: OmegaOptions = {} as OmegaOptions;
  _storage!: Storage;
  _state!: Storage;
  _currentProfileName: string | null = null;
  _revertToProfileName: string | null = null;
  _watchingProfiles: Record<string, string> = {};
  _tempProfile: any = null;
  _tempProfileActive = false;
  _tempProfileRules: Record<string, any> = {};
  _tempProfileRulesByProfile: Record<string, any[]> = {};
  _externalProfile: any = null;
  _isSystem = false;
  _syncWatchStop: (() => void) | null = null;
  _watchStop: (() => void) | null = null;
  fallbackProfileName = 'system';
  debugStr = 'Options';
  ready: Promise<OmegaOptions> | null = null;
  log: typeof Log;
  sync: OptionsSync | null;
  proxyImpl: any;

  static transformValueForSync(value: any, key: string): any {
    if (key[0] === '+') {
      if (OmegaPac.Profiles.updateUrl(value)) {
        const profile: any = {};
        for (const [k, v] of Object.entries(value)) {
          if (k === 'lastUpdate' || k === 'ruleList' || k === 'pacScript') continue;
          profile[k] = v;
        }
        value = profile;
      }
    }
    return value;
  }

  constructor(
    options: OmegaOptions | null | undefined,
    _storage?: Storage,
    _state?: Storage,
    log?: typeof Log,
    sync?: OptionsSync | null,
    proxyImpl?: any
  ) {
    this._storage = _storage ?? new Storage();
    this._state = _state ?? new Storage();
    this.log = log ?? Log;
    this.sync = sync ?? null;
    this.proxyImpl = proxyImpl;

    if (options == null) {
      this.init();
    } else {
      this.ready = this._storage.remove().then(() =>
        this._storage.set(options as any)
      ).then(() => this.init()) as any;
    }
  }

  loadOptions({ retry }: { retry?: number } = {}): Promise<OmegaOptions> {
    retry = retry ?? 3;
    this._syncWatchStop?.();
    this._syncWatchStop = null;
    this._watchStop?.();
    this._watchStop = null;

    let loadRaw: Promise<any>;
    if (!this.sync?.enabled) {
      if (!this.sync) {
        this._state.set({ syncOptions: 'unsupported' });
      }
      loadRaw = this._storage.get(null);
    } else {
      this._state.set({ syncOptions: 'sync' });
      this._syncWatchStop = this.sync.watchAndPull(this._storage);
      loadRaw = this.sync.copyTo(this._storage).catch((e: any) => {
        if (e instanceof Storage.StorageUnavailableError) {
          console.error('Warning: Sync storage is not available in this browser! Disabling options sync.');
          this._syncWatchStop?.();
          this._syncWatchStop = null;
          this.sync = null;
          this._state.set({ syncOptions: 'unsupported' });
        } else throw e;
      }).then(() => this._storage.get(null));
    }

    const optionsLoaded: Promise<OmegaOptions> = loadRaw.then((options) =>
      this.upgrade(options)
    ).then(([options, changes]: [any, any]) =>
      this._storage.apply({ changes }).then(() => options)
    ).then((options: OmegaOptions) => {
      this._options = options;
      this._watchStop = this._watch();
      this._state.get({ syncOptions: '' }).then(({ syncOptions }) => {
        if (syncOptions) return;
        this._state.set({ syncOptions: 'conflict' });
        this.sync?.storage.get('schemaVersion').then(({ schemaVersion }: any) => {
          if (!schemaVersion) this._state.set({ syncOptions: 'pristine' });
        });
      });
      return options;
    }).catch((e: any) => {
      if (retry! <= 0) return Promise.reject(e);

      const getFallbackOptions: Promise<OmegaOptions | null> = Promise.resolve().then(() => {
        if (e instanceof NoOptionsError) {
          this._state.get({ firstRun: 'new', 'web.switchGuide': 'showOnFirstUse' })
            .then((items: any) => this._state.set(items));
          if (!this.sync) return null;
          return this._state.get({ syncOptions: '' }).then(({ syncOptions }: any) => {
            if (syncOptions === 'conflict') return null;
            return this.sync!.storage.get(null).then((opts: any) => {
              if (!opts['schemaVersion']) {
                this._state.set({ syncOptions: 'pristine' });
                return null;
              } else {
                this._state.set({ syncOptions: 'sync' });
                this.sync!.enabled = true;
                this.log.log('Options#loadOptions::fromSync', opts);
                return opts;
              }
            }).catch(() => null);
          });
        } else {
          this.log.error(e.stack);
          this._state.remove(['syncOptions']);
          return null;
        }
      });

      return getFallbackOptions.then((opts) => {
        const options = opts ?? this.parseOptions(this.getDefaultOptions());
        const prevEnabled = this.sync?.enabled;
        if (this.sync) this.sync.enabled = false;
        return this._storage.remove().then(() =>
          this._storage.set(options as any)
        ).then(() => {
          if (this.sync && prevEnabled !== undefined) this.sync.enabled = prevEnabled;
          return this.loadOptions({ retry: retry! - 1 });
        });
      });
    });

    return optionsLoaded;
  }

  init(): Promise<OmegaOptions> {
    const doInit = this.loadOptions().then(() => {
      if (this._options['-startupProfileName']) {
        return this.applyProfile(this._options['-startupProfileName']);
      } else {
        return this._state.get({ currentProfileName: this.fallbackProfileName, isSystemProfile: false })
          .then((st: any) => {
            if (st['isSystemProfile']) {
              return this.applyProfile('system');
            } else {
              return this.applyProfile(st['currentProfileName'] || this.fallbackProfileName);
            }
          });
      }
    }).catch((err: any) => {
      if (!(err instanceof ProfileNotExistError)) this.log.error(err);
      return this.applyProfile(this.fallbackProfileName);
    }).catch((err: any) => {
      this.log.error(err);
    }).then(() => this.getAll());

    this.ready = doInit as Promise<OmegaOptions>;

    doInit.then(() => {
      if (this.sync?.enabled) this.sync.requestPush(this._options);
      this._state.get({ firstRun: '' }).then(({ firstRun }: any) => {
        if (firstRun) this.onFirstRun(firstRun);
      });
      if (this._options['-downloadInterval'] > 0) this.updateProfile();
    });

    return this.ready;
  }

  toString(): string { return '<Options>'; }

  printProfile(_profile: any): string | null { return null; }

  upgrade(options: any, changes?: any): Promise<[OmegaOptions, Record<string, any>]> {
    changes = changes ?? {};
    const version = options?.['schemaVersion'];
    if (version === 1) {
      let autoDetectUsed = false;
      OmegaPac.Profiles.each(options, (_key: string, profile: any) => {
        if (!autoDetectUsed) {
          const refs = OmegaPac.Profiles.directReferenceSet(profile);
          if (refs['+auto_detect']) autoDetectUsed = true;
        }
      });
      if (autoDetectUsed) {
        options['+auto_detect'] = OmegaPac.Profiles.create({
          name: 'auto_detect',
          profileType: 'PacProfile',
          pacUrl: 'http://wpad/wpad.dat',
          color: '#00cccc',
        });
      }
      changes['schemaVersion'] = options['schemaVersion'] = 2;
    }
    if (options?.['schemaVersion'] === 2) {
      return Promise.resolve([options, changes]);
    }
    return Promise.reject(new Error(`Invalid schemaVersion ${version}!`));
  }

  parseOptions(options: any): OmegaOptions {
    if (typeof options === 'string') {
      if (options[0] !== '{') {
        try {
          options = Buffer.from(options, 'base64').toString('utf8');
        } catch (_) {
          options = null;
        }
      }
      try {
        options = JSON.parse(options);
      } catch (_) {
        options = null;
      }
    }
    if (!options) throw new Error('Invalid options!');
    return options;
  }

  reset(options?: any): Promise<OmegaOptions> {
    this.log.method('Options#reset', this, arguments);
    options = options ?? this.getDefaultOptions();
    return this.upgrade(this.parseOptions(options)).then(([opt]: any) => {
      if (this.sync) this.sync.enabled = false;
      this._state.remove(['syncOptions']);
      return this._storage.remove().then(() => this._storage.set(opt)).then(() => this.init());
    });
  }

  onFirstRun(_reason: string): void {}

  getDefaultOptions(): OmegaOptions { return defaultOptions(); }

  getAll(): OmegaOptions { return this._options; }

  profile(name: string): any { return OmegaPac.Profiles.byName(name, this._options); }

  patch(patch: any): Promise<OmegaOptions> | undefined {
    if (!patch) return;
    this.log.method('Options#patch', this, arguments);
    this._options = jsondiffpatch.patch(this._options, patch);
    const changes: Record<string, any> = {};
    for (const [key, delta] of Object.entries(patch as Record<string, any>)) {
      if (Array.isArray(delta) && delta.length === 3 && delta[1] === 0 && delta[2] === 0) {
        changes[key] = undefined;
      } else {
        changes[key] = (this._options as any)[key];
      }
    }
    return this._setOptions(changes);
  }

  _setOptions = (changes: Record<string, any>, args?: any): Promise<OmegaOptions> => {
    const removed: string[] = [];
    const checkRev = args?.checkRevision ?? false;
    let profilesChanged = false;
    let currentProfileAffected: string | false = false;

    for (const [key, value] of Object.entries(changes)) {
      if (typeof value === 'undefined') {
        delete (this._options as any)[key];
        removed.push(key);
        if (key[0] === '+') {
          profilesChanged = true;
          if (key === '+' + this._currentProfileName) currentProfileAffected = 'removed';
        }
      } else {
        if (key[0] === '+') {
          if (checkRev && (this._options as any)[key]) {
            const result = OmegaPac.Revision.compare((this._options as any)[key].revision, value.revision);
            if (result >= 0) continue;
          }
          profilesChanged = true;
        }
        (this._options as any)[key] = value;
      }
      if (!currentProfileAffected && this._watchingProfiles[key]) {
        currentProfileAffected = 'changed';
      }
    }

    switch (currentProfileAffected) {
      case 'removed': this.applyProfile(this.fallbackProfileName); break;
      case 'changed': this.applyProfile(this._currentProfileName!, { update: false }); break;
      default: if (profilesChanged) this._setAvailableProfiles(); break;
    }

    if (args?.persist !== false) {
      if (this.sync?.enabled) this.sync.requestPush(changes);
      for (const key of removed) delete changes[key];
      return this._storage.set(changes).then(() =>
        this._storage.remove(removed)
      ).then(() => this._options);
    }
    return Promise.resolve(this._options);
  };

  _watch(): () => void {
    const handler = (changes?: Record<string, any>) => {
      if (changes) {
        this._setOptions(changes, { checkRevision: true, persist: false });
      } else {
        changes = this._options as any;
      }

      const refresh = (changes as any)['-refreshOnProfileChange'];
      if (refresh != null) this._state.set({ refreshOnProfileChange: refresh });

      if (Object.prototype.hasOwnProperty.call(changes, '-showExternalProfile')) {
        let showExternal = (changes as any)['-showExternalProfile'];
        if (showExternal == null) {
          showExternal = true;
          this._setOptions({ '-showExternalProfile': true }, { persist: true });
        }
        this._state.set({ showExternalProfile: showExternal });
      }

      const quickSwitchProfiles = this._cleanUpQuickSwitchProfiles((changes as any)['-quickSwitchProfiles']);
      if ((changes as any)['-enableQuickSwitch'] != null || quickSwitchProfiles != null) {
        this.reloadQuickSwitch();
      }
      if ((changes as any)['-downloadInterval'] != null) {
        this.schedule('updateProfile', this._options['-downloadInterval'], () => this.updateProfile());
      }
      if ((changes as any)['-showInspectMenu'] != null || changes === (this._options as any)) {
        let showMenu = this._options['-showInspectMenu'];
        if (showMenu == null) {
          showMenu = true;
          this._setOptions({ '-showInspectMenu': true }, { persist: true });
        }
        this.setInspect({ showMenu });
      }
      if ((changes as any)['-monitorWebRequests'] != null || changes === (this._options as any)) {
        let monitorWebRequests = (this._options as any)['-monitorWebRequests'];
        if (monitorWebRequests == null) {
          monitorWebRequests = true;
          this._setOptions({ '-monitorWebRequests': true }, { persist: true });
        }
        this.setMonitorWebRequests(monitorWebRequests);
      }
    };

    handler();
    return this._storage.watch(null, handler);
  }

  _cleanUpQuickSwitchProfiles(quickSwitchProfiles?: string[]): string[] | undefined {
    if (quickSwitchProfiles == null) return undefined;
    const seen: Record<string, boolean> = {};
    const valid = quickSwitchProfiles.filter((name) => {
      if (!name) return false;
      const key = OmegaPac.Profiles.nameAsKey(name);
      if (seen[key]) return false;
      if (!OmegaPac.Profiles.byName(name, this._options)) return false;
      seen[key] = true;
      return true;
    });
    if (valid.length !== quickSwitchProfiles.length) {
      this._setOptions({ '-quickSwitchProfiles': valid }, { persist: true });
    }
    return valid;
  }

  reloadQuickSwitch(): void {
    let profiles = this._options['-quickSwitchProfiles'];
    if (profiles.length < 2) profiles = null as any;
    if (this._options['-enableQuickSwitch']) {
      this.setQuickSwitch(profiles, !!profiles);
    } else {
      this.setQuickSwitch(null, !!profiles);
    }
  }

  setInspect(_settings: { showMenu: boolean }): Promise<void> { return Promise.resolve(); }

  setMonitorWebRequests(_enabled: boolean): Promise<void> { return Promise.resolve(); }

  watch(callback: (changes: Record<string, any>) => void): () => void {
    return this._storage.watch(null, callback);
  }

  _profileNotFound(name: string): any {
    this.log.error(`Profile ${name} not found! Things may go very, very wrong.`);
    return OmegaPac.Profiles.create({ name, profileType: 'VirtualProfile', defaultProfileName: 'direct' });
  }

  pacForProfile(profile: any, compress = false): Promise<string> {
    let ast = OmegaPac.PacGenerator.script(this._options, profile, {
      profileNotFound: this._profileNotFound.bind(this),
    });
    if (compress) ast = OmegaPac.PacGenerator.compress(ast);
    return Promise.resolve(OmegaPac.PacGenerator.ascii(ast.print_to_string()));
  }

  _setAvailableProfiles(): void {
    const profile = this._currentProfileName ? this.currentProfile() : null;
    const profiles: Record<string, any> = {};
    const currentIncludable = profile && OmegaPac.Profiles.isIncludable(profile);
    let allReferenceSet: any = null;
    let results: string[] | undefined;
    if (!profile || !OmegaPac.Profiles.isInclusive(profile)) results = [];

    OmegaPac.Profiles.each(this._options, (key: string, p: any) => {
      profiles[key] = {
        name: p.name,
        profileType: p.profileType,
        color: p.color,
        desc: this.printProfile(p),
        builtin: p.builtin ? true : undefined,
      };
      if (p.profileType === 'VirtualProfile') {
        profiles[key].defaultProfileName = p.defaultProfileName;
        if (allReferenceSet == null) {
          allReferenceSet = profile
            ? OmegaPac.Profiles.allReferenceSet(profile, this._options, { profileNotFound: this._profileNotFound.bind(this) })
            : {};
        }
        if (allReferenceSet[key]) {
          profiles[key].validResultProfiles = OmegaPac.Profiles.validResultProfilesFor(p, this._options).map((r: any) => r.name);
        }
      }
      if (currentIncludable && OmegaPac.Profiles.isIncludable(p)) results?.push(p.name);
    });

    if (profile && OmegaPac.Profiles.isInclusive(profile)) {
      results = OmegaPac.Profiles.validResultProfilesFor(profile, this._options).map((p: any) => p.name);
    }

    this._state.set({ availableProfiles: profiles, validResultProfiles: results });
  }

  applyProfile(name: string, options?: any): Promise<void> {
    this.log.method('Options#applyProfile', this, arguments);
    const profile = OmegaPac.Profiles.byName(name, this._options);
    if (!profile) return Promise.reject(new ProfileNotExistError(name));

    this._currentProfileName = profile.name;
    this._isSystem = options?.system || (profile.profileType === 'SystemProfile');
    this._watchingProfiles = OmegaPac.Profiles.allReferenceSet(profile, this._options, {
      profileNotFound: this._profileNotFound.bind(this),
    });

    this._state.set({
      currentProfileName: this._currentProfileName,
      isSystemProfile: this._isSystem,
      currentProfileCanAddRule: profile.rules != null && profile.profileType !== 'VirtualProfile',
    });
    this._setAvailableProfiles();
    this.currentProfileChanged(options?.reason);

    if (options?.proxy === false) return Promise.resolve();

    this._tempProfileActive = false;
    if (this._tempProfile != null && OmegaPac.Profiles.isIncludable(profile)) {
      this._tempProfileActive = true;
      if (this._tempProfile.defaultProfileName !== profile.name) {
        this._tempProfile.defaultProfileName = profile.name;
        this._tempProfile.color = profile.color;
        OmegaPac.Profiles.updateRevision(this._tempProfile);
      }

      const removedKeys: string[] = [];
      for (const [key, list] of Object.entries(this._tempProfileRulesByProfile)) {
        if (!OmegaPac.Profiles.byKey(key, this._options)) {
          removedKeys.push(key);
          for (const rule of list as any[]) {
            rule.profileName = null;
            this._tempProfile.rules.splice(this._tempProfile.rules.indexOf(rule), 1);
          }
        }
      }
      if (removedKeys.length > 0) {
        for (const key of removedKeys) delete this._tempProfileRulesByProfile[key];
        OmegaPac.Profiles.updateRevision(this._tempProfile);
      }

      this._watchingProfiles = OmegaPac.Profiles.allReferenceSet(this._tempProfile, this._options, {
        profileNotFound: this._profileNotFound.bind(this),
      });
    }

    const applyProxy = this._tempProfileActive
      ? this.proxyImpl.applyProfile(this._tempProfile, profile, this._options)
      : this.proxyImpl.applyProfile(profile, profile, this._options);

    if (options?.update === false) return applyProxy;

    return applyProxy.then(() => {
      if (!(this._options['-downloadInterval'] > 0)) return;
      if (this._currentProfileName !== profile.name) return;
      const updateProfiles = Object.values(this._watchingProfiles);
      if (updateProfiles.length > 0) this.updateProfile(updateProfiles as any);
    });
  }

  currentProfile(): any {
    return this._currentProfileName
      ? OmegaPac.Profiles.byName(this._currentProfileName, this._options)
      : this._externalProfile;
  }

  isSystem(): boolean { return this._isSystem; }

  currentProfileChanged(_reason?: string): void {}

  setQuickSwitch(_quickSwitch: string[] | null, _canEnable: boolean): Promise<void> {
    return Promise.resolve();
  }

  schedule(_name: string, _periodInMinutes: number, _callback: () => void): Promise<void> {
    return Promise.resolve();
  }

  isCurrentProfileStatic(): boolean {
    if (!this._currentProfileName) return true;
    if (this._tempProfileActive) return false;
    const current = this.currentProfile();
    if (OmegaPac.Profiles.isInclusive(current)) return false;
    return true;
  }

  updateProfile(name?: string | string[] | null, opt_bypass_cache?: boolean): Promise<Record<string, any>> {
    this.log.method('Options#updateProfile', this, arguments);
    const results: Record<string, Promise<any>> = {};
    OmegaPac.Profiles.each(this._options, (key: string, profile: any) => {
      if (name != null) {
        if (Array.isArray(name)) { if (!name.includes(profile.name)) return; }
        else { if (profile.name !== name) return; }
      }
      const url = OmegaPac.Profiles.updateUrl(profile);
      if (url) {
        const typeHints = OmegaPac.Profiles.updateContentTypeHints(profile);
        results[key] = this.fetchUrl(url, opt_bypass_cache, typeHints).then((data: any) => {
          if (!data) return profile;
          profile = OmegaPac.Profiles.byKey(key, this._options);
          profile.lastUpdate = new Date().toISOString();
          if (OmegaPac.Profiles.update(profile, data)) {
            OmegaPac.Profiles.dropCache(profile);
            const changes: Record<string, any> = {};
            changes[key] = profile;
            return this._setOptions(changes).then(() => profile);
          }
          return profile;
        }).catch((reason: any) => reason instanceof Error ? reason : new Error(reason));
      }
    });
    return Promise.all(Object.entries(results).map(([k, p]) => p.then((v: any) => [k, v]))).then((entries: any[]) =>
      Object.fromEntries(entries)
    );
  }

  fetchUrl(_url: string, _opt_bypass_cache?: boolean, _opt_type_hints?: string[]): Promise<string> {
    return Promise.reject(new Error('not implemented'));
  }

  _replaceRefChanges(fromName: string, toName: string, changes: Record<string, any> = {}): Record<string, any> {
    OmegaPac.Profiles.each(this._options, (_key: string, p: any) => {
      if (p.name === fromName || p.name === toName) return;
      if (OmegaPac.Profiles.replaceRef(p, fromName, toName)) {
        OmegaPac.Profiles.updateRevision(p);
        changes[OmegaPac.Profiles.nameAsKey(p)] = p;
      }
    });

    if (this._options['-startupProfileName'] === fromName) changes['-startupProfileName'] = toName;
    const quickSwitch = this._options['-quickSwitchProfiles'];
    if (quickSwitch.indexOf(toName) < 0) {
      for (let i = 0; i < quickSwitch.length; i++) {
        if (quickSwitch[i] === fromName) {
          quickSwitch[i] = toName;
          changes['-quickSwitchProfiles'] = quickSwitch;
        }
      }
    }
    return changes;
  }

  replaceRef(fromName: string, toName: string): Promise<OmegaOptions> {
    this.log.method('Options#replaceRef', this, arguments);
    if (!OmegaPac.Profiles.byName(fromName, this._options)) {
      return Promise.reject(new ProfileNotExistError(fromName));
    }
    const changes = this._replaceRefChanges(fromName, toName);
    for (const [key, value] of Object.entries(changes)) {
      (this._options as any)[key] = value;
    }
    const fromKey = OmegaPac.Profiles.nameAsKey(fromName);
    if (this._watchingProfiles[fromKey]) {
      if (this._currentProfileName === fromName) this._currentProfileName = toName;
      this.applyProfile(this._currentProfileName!);
    }
    return this._setOptions(changes);
  }

  renameProfile(fromName: string, toName: string): Promise<OmegaOptions> {
    this.log.method('Options#renameProfile', this, arguments);
    if (OmegaPac.Profiles.byName(toName, this._options)) {
      return Promise.reject(new Error(`Target name ${toName} already taken!`));
    }
    const profile = OmegaPac.Profiles.byName(fromName, this._options);
    if (!profile) return Promise.reject(new ProfileNotExistError(fromName));

    profile.name = toName;
    const changes: Record<string, any> = {};
    changes[OmegaPac.Profiles.nameAsKey(profile)] = profile;
    this._replaceRefChanges(fromName, toName, changes);

    for (const [key, value] of Object.entries(changes)) {
      (this._options as any)[key] = value;
    }
    const fromKey = OmegaPac.Profiles.nameAsKey(fromName);
    changes[fromKey] = undefined;
    delete (this._options as any)[fromKey];

    if (this._watchingProfiles[fromKey]) {
      if (this._currentProfileName === fromName) this._currentProfileName = toName;
      this.applyProfile(this._currentProfileName!);
    }
    return this._setOptions(changes);
  }

  addTempRule(domain: string, profileName: string): Promise<void> {
    this.log.method('Options#addTempRule', this, arguments);
    if (!this._currentProfileName) return Promise.resolve();
    const profile = OmegaPac.Profiles.byName(profileName, this._options);
    if (!profile) return Promise.reject(new ProfileNotExistError(profileName));

    if (!this._tempProfile) {
      this._tempProfile = OmegaPac.Profiles.create('', 'SwitchProfile');
      const current = this.currentProfile();
      this._tempProfile.color = current.color;
      this._tempProfile.defaultProfileName = current.name;
    }

    let changed = false;
    let rule = this._tempProfileRules[domain];
    if (rule && rule.profileName) {
      if (rule.profileName !== profileName) {
        const key = OmegaPac.Profiles.nameAsKey(rule.profileName);
        const list = this._tempProfileRulesByProfile[key];
        list.splice(list.indexOf(rule), 1);
        rule.profileName = profileName;
        changed = true;
      }
    } else {
      rule = {
        condition: { conditionType: 'HostWildcardCondition', pattern: '*.' + domain },
        profileName,
        isTempRule: true,
      };
      this._tempProfile.rules.push(rule);
      this._tempProfileRules[domain] = rule;
      changed = true;
    }

    const key = OmegaPac.Profiles.nameAsKey(profileName);
    let rulesByProfile = this._tempProfileRulesByProfile[key];
    if (!rulesByProfile) rulesByProfile = this._tempProfileRulesByProfile[key] = [];
    rulesByProfile.push(rule);

    if (changed) {
      OmegaPac.Profiles.updateRevision(this._tempProfile);
      return this.applyProfile(this._currentProfileName);
    }
    return Promise.resolve();
  }

  queryTempRule(domain: string): string | null {
    const rule = this._tempProfileRules[domain];
    if (rule) {
      if (rule.profileName) return rule.profileName;
      delete this._tempProfileRules[domain];
    }
    return null;
  }

  addCondition(condition: any | any[], profileName: string): Promise<OmegaOptions> {
    this.log.method('Options#addCondition', this, arguments);
    if (!this._currentProfileName) return Promise.resolve(this._options);
    const profile = OmegaPac.Profiles.byName(this._currentProfileName, this._options);
    if (!profile?.rules) {
      return Promise.reject(new Error(`Cannot add condition to Profile ${profile?.name} (${profile?.profileType})`));
    }
    const target = OmegaPac.Profiles.byName(profileName, this._options);
    if (!target) return Promise.reject(new ProfileNotExistError(profileName));

    const conditions = Array.isArray(condition) ? condition : [condition];
    for (const cond of conditions) {
      const tag = OmegaPac.Conditions.tag(cond);
      for (let i = 0; i < profile.rules.length; i++) {
        if (OmegaPac.Conditions.tag(profile.rules[i].condition) === tag) {
          profile.rules.splice(i, 1);
          break;
        }
      }
      if (this._options['-addConditionsToBottom']) {
        profile.rules.push({ condition: cond, profileName });
      } else {
        profile.rules.unshift({ condition: cond, profileName });
      }
    }

    OmegaPac.Profiles.updateRevision(profile);
    const changes: Record<string, any> = {};
    changes[OmegaPac.Profiles.nameAsKey(profile)] = profile;
    return this._setOptions(changes);
  }

  setDefaultProfile(profileName: string, defaultProfileName: string): Promise<OmegaOptions> {
    this.log.method('Options#setDefaultProfile', this, arguments);
    const profile = OmegaPac.Profiles.byName(profileName, this._options);
    if (!profile) return Promise.reject(new ProfileNotExistError(profileName));
    if (profile.defaultProfileName == null) {
      return Promise.reject(new Error(`Profile ${profile.name} (${profile.profileType}) does not have defaultProfileName!`));
    }
    const target = OmegaPac.Profiles.byName(defaultProfileName, this._options);
    if (!target) return Promise.reject(new ProfileNotExistError(defaultProfileName));

    profile.defaultProfileName = defaultProfileName;
    OmegaPac.Profiles.updateRevision(profile);
    const changes: Record<string, any> = {};
    changes[OmegaPac.Profiles.nameAsKey(profile)] = profile;
    return this._setOptions(changes);
  }

  addProfile(profile: any): Promise<OmegaOptions> {
    this.log.method('Options#addProfile', this, arguments);
    if (OmegaPac.Profiles.byName(profile.name, this._options)) {
      return Promise.reject(new Error(`Target name ${profile.name} already taken!`));
    }
    const changes: Record<string, any> = {};
    changes[OmegaPac.Profiles.nameAsKey(profile)] = profile;
    return this._setOptions(changes);
  }

  matchProfile(request: any): Promise<{ profile: any; results: any[] }> {
    if (!this._currentProfileName) return Promise.resolve({ profile: this._externalProfile, results: [] });
    const results: any[] = [];
    let profile = this._tempProfileActive
      ? this._tempProfile
      : OmegaPac.Profiles.byName(this._currentProfileName, this._options);
    let lastProfile = profile;
    while (profile) {
      lastProfile = profile;
      const result = OmegaPac.Profiles.match(profile, request);
      if (result == null) break;
      results.push(result);
      let next: string | undefined;
      if (Array.isArray(result)) next = result[0];
      else if (result.profileName) next = OmegaPac.Profiles.nameAsKey(result.profileName);
      else break;
      profile = OmegaPac.Profiles.byKey(next, this._options);
    }
    return Promise.resolve({ profile: lastProfile, results });
  }

  setExternalProfile(profile: any, args?: any): void | Promise<void> {
    if (this._options['-revertProxyChanges'] && !this._isSystem) {
      if (profile.name !== this._currentProfileName && this._currentProfileName) {
        if (!args?.noRevert) {
          this.applyProfile(this._revertToProfileName!);
          this._revertToProfileName = null;
          return;
        } else {
          this._revertToProfileName = this._revertToProfileName ?? this._currentProfileName;
        }
      }
    }
    const p = OmegaPac.Profiles.byName(profile.name, this._options);
    if (p) {
      if (args?.internal) {
        return this.applyProfile(p.name, { proxy: false });
      } else {
        return this.applyProfile(p.name, { proxy: false, system: this._isSystem, reason: 'external' });
      }
    } else {
      this._currentProfileName = null;
      this._externalProfile = profile;
      if (!profile.color) profile.color = '#49afcd';
      this._state.set({
        currentProfileName: '',
        externalProfile: profile,
        validResultProfiles: [],
        currentProfileCanAddRule: false,
      });
      this.currentProfileChanged('external');
    }
  }

  setOptionsSync(enabled: boolean, args?: { force?: boolean }): Promise<void> {
    this.log.method('Options#setOptionsSync', this, arguments);
    if (!this.sync) return Promise.reject(new Error('Options syncing is unsupported.'));
    return this._state.get({ syncOptions: '' }).then(({ syncOptions }) => {
      if (!enabled) {
        if (syncOptions === 'sync') this._state.set({ syncOptions: 'conflict' });
        this.sync!.enabled = false;
        this._syncWatchStop?.();
        this._syncWatchStop = null;
        return;
      }
      if (syncOptions === 'conflict' && !args?.force) {
        return Promise.reject(new Error('Syncing not enabled due to conflict. Retry with force to overwrite local options and enable syncing.'));
      }
      if (syncOptions === 'sync') return;
      return this._state.set({ syncOptions: 'sync' }).then(() => {
        if (syncOptions === 'conflict') {
          this.sync!.enabled = false;
          return this._storage.remove().then(() => {
            this.sync!.enabled = true;
            this.init();
          });
        } else {
          this.sync!.enabled = true;
          this._syncWatchStop?.();
          this.sync!.requestPush(this._options);
          this._syncWatchStop = this.sync!.watchAndPull(this._storage);
        }
      });
    });
  }

  resetOptionsSync(): Promise<void> {
    this.log.method('Options#resetOptionsSync', this, arguments);
    if (!this.sync) return Promise.reject(new Error('Options syncing is unsupported.'));
    this.sync.enabled = false;
    this._syncWatchStop?.();
    this._syncWatchStop = null;
    this._state.set({ syncOptions: 'conflict' });
    return this.sync.storage.remove().then(() => this._state.set({ syncOptions: 'pristine' }));
  }
}

module.exports = Options;
export default Options;
