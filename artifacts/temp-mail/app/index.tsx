import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar as NativeStatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  createMailMailbox as createMailTmMailbox,
  deleteMailMessage as deleteMailTmMessage,
  getMailMessage as getMailTmMessage,
  getMailboxToken,
  listMailDomains as listMailTmDomains,
  listMailMessages as listMailTmMessages,
  setMailboxToken,
} from '@/lib/mail-session';
import type { MailMessageDetail, MailMessageSummary } from '@/lib/mail-session';
import palette from '@/constants/colors';

type Screen = 'email' | 'inbox' | 'switch' | 'other';
type AddressRecord = { address: string; createdAt: string };
type RuntimeSession = { address: string; token: string; createdAt: string; id?: string; password?: string };
type SavedSnapshot = {
  message: MailMessageSummary;
  body: string;
  savedAt: string;
};
type Preferences = { autoRefresh: boolean; haptics: boolean; darkMode: boolean };
type AppColors = typeof palette.dark & { radius: number };
const STORAGE = {
  activeMailbox: '@temp-mail/active-mailbox-v1',
  history: '@temp-mail/address-history-v1',
  saved: '@temp-mail/saved-messages-v1',
  preferences: '@temp-mail/preferences-v1',
};

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function initials(name: string) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'M';
}

function safeMessageText(text: string | null | undefined, html: string[]) {
  if (text?.trim()) return text.trim();
  return html.join('\n')
    .replace(/<(script|style|iframe|object|svg|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function otpFrom(text: string) {
  const match = text.match(/(?:^|\D)(\d{4,8})(?!\d)/);
  return match?.[1] ?? null;
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export default function InboxScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const domains = useQuery({
    queryKey: ['mail', 'domains'],
    queryFn: listMailTmDomains,
    retry: false,
    staleTime: 60_000,
  });
  const [screen, setScreen] = useState<Screen>('email');
  const [address, setAddress] = useState<string | null>(null);
  const [runtimeSessions, setRuntimeSessions] = useState<RuntimeSession[]>([]);
  const [selectedMessage, setSelectedMessage] = useState<MailMessageSummary | null>(null);
  const [savedSelection, setSavedSelection] = useState<SavedSnapshot | null>(null);
  const [history, setHistory] = useState<AddressRecord[]>([]);
  const [sessionCounts, setSessionCounts] = useState<Record<string, number>>({});
  const [savedMessages, setSavedMessages] = useState<SavedSnapshot[]>([]);
  const [preferences, setPreferences] = useState<Preferences>({ autoRefresh: true, haptics: true, darkMode: true });
  const [sessionMode, setSessionMode] = useState<'Random' | 'Domain' | 'Popular'>('Random');
  const [domainSearch, setDomainSearch] = useState('');
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [requestedUsername, setRequestedUsername] = useState('');
  const [selectorVisible, setSelectorVisible] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const [language, setLanguage] = useState('English');
  const [storageReady, setStorageReady] = useState(false);
  const [mailboxError, setMailboxError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [toastTone, setToastTone] = useState<'success' | 'error' | 'info'>('info');
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstLoadStarted = useRef(false);
  const inboxHasLoaded = useRef(false);
  const previousMessageIds = useRef<Set<string>>(new Set());
  const pulse = useRef(new Animated.Value(0.35)).current;
  const dockProgress = useRef(new Animated.Value(0)).current;
  const [dockWidth, setDockWidth] = useState(0);
  const domainSearchRef = useRef<TextInput>(null);
  const sheetProgress = useRef(new Animated.Value(0)).current;
  const selectedId = selectedMessage?.id ?? '';
  const colors: AppColors = { ...(preferences.darkMode ? palette.dark : palette.light), radius: palette.radius };
  const normalizedUsername = requestedUsername.trim().toLowerCase();
  const usernameIsValid =
    !normalizedUsername || /^[a-z0-9._-]{1,64}$/.test(normalizedUsername);

  const feedback = useCallback((kind: 'selection' | 'success' = 'selection') => {
    if (!preferences.haptics) return;
    if (kind === 'success') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      void Haptics.selectionAsync();
    }
  }, [preferences.haptics]);

  const showToast = useCallback((message: string, tone: 'success' | 'error' | 'info' = 'info') => {
    setToast(message);
    setToastTone(tone);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2300);
  }, []);

  const createMailbox = useMutation({
      mutationFn: ({ domain, username }: { domain: string; username?: string }) =>
        createMailTmMailbox(domain, username),
      onSuccess: (session) => {
        const createdAt = new Date().toISOString();
        queryClient.removeQueries({ queryKey: ['mail', 'messages'] });
        setMailboxToken(session.token);
        setAddress(session.address);
        void AsyncStorage.setItem(
          STORAGE.activeMailbox,
          JSON.stringify({ ...session, createdAt }),
        ).catch(() => showToast('Mailbox created, but could not be saved on this device'));
        setRuntimeSessions((current) => [
          { ...session, createdAt },
          ...current.filter((entry) => entry.address !== session.address),
        ]);
        setSelectedMessage(null);
        setSavedSelection(null);
        setMailboxError(null);
        inboxHasLoaded.current = false;
        previousMessageIds.current = new Set();
        setHistory((current) => [
          { address: session.address, createdAt },
          ...current.filter((entry) => entry.address !== session.address),
        ].slice(0, 60));
        setScreen('email');
        feedback('success');
        setSelectorVisible(false);
      },
      onError: (error) => {
        console.error('[temp-mail] Could not create a Mail.tm address:', error);
        setMailboxError(readableError(error));
        showToast('Address could not be created', 'error');
      },
  });

  const messages = useQuery({
    queryKey: ['mail', 'messages', address],
    queryFn: () => {
      const token = getMailboxToken();
      if (!token) throw new Error('This mailbox session has expired. Create a new address to continue.');
      return listMailTmMessages(token);
    },
    enabled: Boolean(address),
    refetchInterval: address && preferences.autoRefresh ? 4500 : false,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });
  const messageDetail = useQuery({
    queryKey: ['mail', 'message', address, selectedId],
    queryFn: () => {
      const token = getMailboxToken();
      if (!token) throw new Error('This mailbox session has expired. Create a new address to continue.');
      return getMailTmMessage(token, selectedId);
    },
    enabled: Boolean(selectedId && address && !savedSelection),
  });
  const deleteMessage = useMutation({
      mutationFn: (messageId: string) => {
        const token = getMailboxToken();
        if (!token) throw new Error('This mailbox session has expired. Create a new address to continue.');
        return deleteMailTmMessage(token, messageId);
      },
      onSuccess: () => {
        setSelectedMessage(null);
        void queryClient.invalidateQueries({ queryKey: ['mail', 'messages', address] });
        showToast('Email deleted');
        feedback('success');
      },
      onError: (error) => showToast(readableError(error)),
  });

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      AsyncStorage.getItem(STORAGE.activeMailbox),
      AsyncStorage.getItem(STORAGE.history),
      AsyncStorage.getItem(STORAGE.saved),
      AsyncStorage.getItem(STORAGE.preferences),
    ]).then(([activeMailboxValue, historyValue, savedValue, preferenceValue]) => {
      if (!mounted) return;
      try {
        if (activeMailboxValue) {
          const active = JSON.parse(activeMailboxValue) as RuntimeSession;
          if (active.address && active.token) {
            setMailboxToken(active.token);
            setAddress(active.address);
            setRuntimeSessions([active]);
            firstLoadStarted.current = true;
          }
        }
      } catch { /* recover from invalid active mailbox cache */ }
      try { if (historyValue) setHistory(JSON.parse(historyValue) as AddressRecord[]); } catch { /* recover from invalid local cache */ }
      try { if (savedValue) setSavedMessages(JSON.parse(savedValue) as SavedSnapshot[]); } catch { /* recover from invalid local cache */ }
      try {
        if (preferenceValue) {
          const stored = JSON.parse(preferenceValue) as Partial<Preferences>;
          setPreferences({
            autoRefresh: stored.autoRefresh !== false,
            haptics: stored.haptics !== false,
            darkMode: stored.darkMode !== false,
          });
          if ('language' in stored && typeof stored.language === 'string') setLanguage(stored.language);
        }
      } catch { /* keep defaults */ }
      setStorageReady(true);
    }).catch(() => setStorageReady(true));
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    void AsyncStorage.multiSet([
      [STORAGE.history, JSON.stringify(history)],
      [STORAGE.saved, JSON.stringify(savedMessages)],
      [STORAGE.preferences, JSON.stringify({ ...preferences, language })],
    ]);
  }, [history, language, preferences, savedMessages, storageReady]);

  useEffect(() => {
    const availableDomains = domains.data?.domains ?? [];
    if (!selectorVisible || !availableDomains.length) return;
    if (!selectedDomain || !availableDomains.some((item) => item.domain === selectedDomain)) {
      setSelectedDomain(availableDomains[0].domain);
    }
  }, [domains.data, selectedDomain, selectorVisible]);

  useEffect(() => {
    if (firstLoadStarted.current || !domains.data || !storageReady || address) return;
    const activeDomain = domains.data.domains[0]?.domain;
    if (!activeDomain) {
      setMailboxError('No active email domains are available right now.');
      return;
    }
    firstLoadStarted.current = true;
    setMailboxError(null);
    createMailbox.mutate({ domain: activeDomain });
  }, [address, domains.data, storageReady, createMailbox.mutate]);

  useEffect(() => {
    if (storageReady && !address && domains.isError) {
      setMailboxError(readableError(domains.error));
    }
  }, [address, domains.error, domains.isError, storageReady]);

  useEffect(() => {
    if (!address || !messages.data) return;
    setSessionCounts((current) => ({ ...current, [address]: messages.data?.totalItems ?? 0 }));
    const currentIds = new Set(messages.data.messages.map((message) => message.id));
    if (inboxHasLoaded.current) {
      const incoming = [...currentIds].filter((id) => !previousMessageIds.current.has(id));
      if (incoming.length) {
        setNewIds((existing) => new Set([...existing, ...incoming]));
        if (newTimer.current) clearTimeout(newTimer.current);
        newTimer.current = setTimeout(() => setNewIds(new Set()), 5000);
        showToast(incoming.length === 1 ? 'New message received' : `${incoming.length} new messages received`);
        feedback('success');
      }
    } else {
      inboxHasLoaded.current = true;
    }
    previousMessageIds.current = currentIds;
  }, [address, feedback, messages.data, showToast]);

  useEffect(() => {
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 1100, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0.35, duration: 1100, useNativeDriver: true }),
    ]));
    animation.start();
    return () => animation.stop();
  }, [pulse]);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    if (newTimer.current) clearTimeout(newTimer.current);
  }, []);

  const createAddressForDomain = (domain: string, username?: string) => {
    if (createMailbox.isPending) return;
    setMailboxError(null);
    firstLoadStarted.current = true;
    createMailbox.mutate({ domain, ...(username ? { username } : {}) });
    feedback();
  };
  const retryInitialSetup = () => {
    setMailboxError(null);
    const activeDomain = domains.data?.domains[0]?.domain;
    if (activeDomain) {
      createAddressForDomain(activeDomain);
    } else {
      void domains.refetch();
    }
  };
  const handleNewAddress = () => {
    setSelectorVisible(true);
    setSessionMode('Random');
    setMailboxError(null);
    const availableDomains = domains.data?.domains ?? [];
    setSelectedDomain(
      availableDomains.length
        ? availableDomains[Math.floor(Math.random() * availableDomains.length)].domain
        : null,
    );
    setDomainSearch('');
    setRequestedUsername('');
    if (!domains.data?.domains.length || domains.isError) {
      void domains.refetch();
    }
    feedback();
  };
  const createSelectedAddress = () => {
    const availableDomains = domains.data?.domains ?? [];
    if (!availableDomains.length || createMailbox.isPending) return;
    if (!usernameIsValid) {
      setMailboxError('Use 1–64 letters, numbers, dots, underscores, or hyphens.');
      return;
    }
    const domain = selectedDomain ?? availableDomains[Math.floor(Math.random() * availableDomains.length)].domain;
    createAddressForDomain(domain, sessionMode === 'Domain' ? normalizedUsername || undefined : undefined);
  };
  const toggleAddressSearch = () => {
    if (searchVisible) {
      setSearchVisible(false);
      setDomainSearch('');
      return;
    }
    setSearchVisible(true);
    setTimeout(() => domainSearchRef.current?.focus(), 80);
  };
  const switchRuntimeSession = (session: RuntimeSession) => {
    if (session.address === address) return;
    queryClient.removeQueries({ queryKey: ['mail', 'messages'] });
    setMailboxToken(session.token);
    setAddress(session.address);
    void AsyncStorage.setItem(STORAGE.activeMailbox, JSON.stringify(session)).catch(() => {
      showToast('Mailbox switched, but could not be saved on this device');
    });
    setSelectedMessage(null);
    setSavedSelection(null);
    setScreen('email');
    inboxHasLoaded.current = false;
    previousMessageIds.current = new Set();
    void queryClient.invalidateQueries({ queryKey: ['mail', 'messages', session.address] });
    feedback();
    showToast('Mailbox switched');
  };

  const handleCopy = async (value: string, message = 'Copied to clipboard!') => {
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        await Clipboard.setStringAsync(value);
      }
      showToast(message, 'success');
      feedback('success');
    } catch (error) {
      console.error('[temp-mail] Could not copy text to the clipboard:', error);
      showToast('Could not copy to clipboard. Please try again.', 'error');
    }
  };

  const handleDelete = () => {
    if (!selectedId || deleteMessage.isPending) return;
    Alert.alert('Delete this email?', 'This message will be removed from the inbox.', [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteMessage.mutate(selectedId) },
    ]);
  };

  const openMessage = (item: MailMessageSummary) => {
    setSavedSelection(null);
    setSelectedMessage(item);
    Animated.spring(sheetProgress, { toValue: 1, damping: 24, stiffness: 210, mass: 0.9, useNativeDriver: true }).start();
    feedback();
  };

  const closeMessage = () => {
    Animated.timing(sheetProgress, { toValue: 0, duration: 180, useNativeDriver: true }).start(({ finished }) => {
      if (finished) {
        setSelectedMessage(null);
        setSavedSelection(null);
      }
    });
  };

  const saveSnapshot = () => {
    if (!selectedMessage) return;
    const detail = messageDetail.data as MailMessageDetail | undefined;
    const snapshot = {
      message: selectedMessage,
      body: detail ? safeMessageText(detail.text, detail.html ?? []) : selectedMessage.intro,
      savedAt: new Date().toISOString(),
    };
    setSavedMessages((items) => [snapshot, ...items.filter((item) => item.message.id !== selectedMessage.id)].slice(0, 100));
    showToast('Saved for later');
    feedback('success');
  };

  const openSaved = (item: SavedSnapshot) => {
    setSavedSelection(item);
    setSelectedMessage(item.message);
    Animated.spring(sheetProgress, { toValue: 1, damping: 24, stiffness: 210, mass: 0.9, useNativeDriver: true }).start();
  };

  const selectedBody = useMemo(() => {
    if (savedSelection) return savedSelection.body;
    return messageDetail.data ? safeMessageText(messageDetail.data.text, messageDetail.data.html ?? []) : '';
  }, [messageDetail.data, savedSelection]);
  const messageOtp = otpFrom(`${selectedMessage?.subject ?? ''} ${selectedMessage?.intro ?? ''} ${selectedBody}`);
  const topInset = Platform.OS === 'web' ? 0 : insets.top;
  const bottomInset = Platform.OS === 'web' ? 34 : insets.bottom;
  const dockBottom = Math.max(bottomInset, 14);
  const sheetY = sheetProgress.interpolate({ inputRange: [0, 1], outputRange: [560, 0] });
  const sheetOpacity = sheetProgress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  const switchScreen = (next: Screen) => {
    setScreen(next);
    Animated.spring(dockProgress, { toValue: next === 'email' ? 0 : next === 'inbox' ? 1 : next === 'switch' ? 2 : 3, damping: 22, stiffness: 220, useNativeDriver: true }).start();
    feedback();
  };

  const clearHistory = () => {
    Alert.alert('Clear address history?', 'Saved messages and the active mailbox will remain.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear history', style: 'destructive', onPress: () => { setHistory([]); showToast('Address history cleared'); } },
    ]);
  };
  const clearSaved = () => {
    Alert.alert('Clear saved messages?', 'This removes all locally saved snapshots.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear saved', style: 'destructive', onPress: () => { setSavedMessages([]); showToast('Saved messages cleared'); } },
    ]);
  };

  const renderMessage = ({ item }: { item: MailMessageSummary }) => {
    return <MessageCard item={item} isNew={newIds.has(item.id)} colors={colors} onPress={() => openMessage(item)} />;
  };

  const inboxTitle = `Inbox${messages.data?.totalItems ? ` (${messages.data.totalItems})` : ''}`;
  const header = (
    <View style={styles.listHeader}>
      <View style={styles.sectionHeading}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>{inboxTitle}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh inbox" testID="refresh-inbox" disabled={!address || messages.isFetching} onPress={() => {
          setRefreshing(true);
          void messages.refetch().finally(() => setRefreshing(false));
        }} style={[styles.refreshButton, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {messages.isFetching ? <ActivityIndicator size="small" color={colors.primary} /> : <Feather name="refresh-cw" size={16} color={colors.foreground} />}
        </Pressable>
      </View>
    </View>
  );

  const emptyComponent = address && messages.isLoading ? (
    <View style={styles.skeletonStack} testID="inbox-loading">
      {[0, 1, 2].map((n) => <View key={n} style={[styles.skeletonCard, { backgroundColor: colors.glass, borderColor: colors.border }]}>
        <View style={[styles.skeletonCircle, { backgroundColor: colors.secondary }]} />
        <View style={styles.skeletonLines}><View style={[styles.shimmerBar, { backgroundColor: colors.secondary, width: '65%' }]} /><View style={[styles.shimmerBar, { backgroundColor: colors.muted, width: '88%' }]} /></View>
      </View>)}
    </View>
  ) : messages.error ? (
    <View style={[styles.emptyState, { backgroundColor: colors.glass, borderColor: colors.border }]}>
      <View style={[styles.emptyIcon, { backgroundColor: colors.accent }]}><Feather name="wifi-off" size={22} color={colors.cyan} /></View>
      <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Can’t reach your inbox</Text>
      <Text style={[styles.emptyCopy, { color: colors.mutedForeground }]}>{readableError(messages.error)}</Text>
      <Pressable accessibilityRole="button" testID="retry-inbox" onPress={() => void messages.refetch()} style={[styles.retryAction, { backgroundColor: colors.secondary }]}>
        <Feather name="rotate-cw" size={14} color={colors.cyan} /><Text style={[styles.retryText, { color: colors.foreground }]}>Try again</Text>
      </Pressable>
    </View>
  ) : address ? (
    <View style={[styles.emptyState, { backgroundColor: colors.glass, borderColor: colors.border }]}>
      <View style={[styles.emptyIcon, { backgroundColor: colors.accent }]}><Feather name="inbox" size={22} color={colors.cyan} /></View>
      <Text style={[styles.emptyTitle, { color: colors.foreground }]}>All quiet for now</Text>
      <Text style={[styles.emptyCopy, { color: colors.mutedForeground }]}>New messages will drift in here automatically.</Text>
      <View style={[styles.waitingChip, { borderColor: colors.border }]}><Animated.View style={[styles.livePulse, { backgroundColor: colors.cyan, opacity: pulse }]} /><Text style={[styles.waitingText, { color: colors.mutedForeground }]}>Listening in the background</Text></View>
    </View>
  ) : null;

  const visibleDomains = (domains.data?.domains ?? []).filter((entry) => entry.domain.toLowerCase().includes(domainSearch.toLowerCase()));
  const switchContent = (
    <ScrollView contentContainerStyle={[styles.page, { paddingBottom: dockBottom + 104 }]} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      {searchVisible ? (
        <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="search" size={17} color={colors.mutedForeground} />
          <TextInput ref={domainSearchRef} accessibilityLabel="Search addresses" testID="address-search" value={domainSearch} onChangeText={setDomainSearch} placeholder="Search addresses" placeholderTextColor={colors.mutedForeground} style={[styles.searchInput, { color: colors.foreground }]} autoCapitalize="none" />
          {domainSearch ? <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setDomainSearch('')}><Feather name="x-circle" size={16} color={colors.mutedForeground} /></Pressable> : null}
        </View>
      ) : null}
      <View style={styles.historySectionHead}><View><Text style={[styles.sectionTitle, { color: colors.foreground }]}>Live sessions</Text><Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>Switch without losing an active mailbox.</Text></View></View>
      {runtimeSessions.length ? runtimeSessions.filter((session) => session.address.toLowerCase().includes(domainSearch.toLowerCase())).map((session, index) => {
        const active = session.address === address;
        return (
          <Pressable key={session.address} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={`${active ? 'Current email' : 'Switch to'} ${session.address}`} testID={`session-${index}`} onPress={() => switchRuntimeSession(session)} style={[styles.sessionRow, { backgroundColor: colors.card, borderColor: active ? colors.primary : colors.border }]}>
            <View style={[styles.sessionAvatar, { backgroundColor: active ? colors.accent : colors.secondary }]}><Text style={[styles.sessionAvatarText, { color: active ? colors.primary : colors.foreground }]}>{initials(session.address.split('@')[0])}</Text></View>
          <View style={styles.historyCopy}><Text numberOfLines={1} style={[styles.historyTitle, { color: colors.foreground }]}>{session.address}</Text><Text style={[styles.historySub, { color: colors.mutedForeground }]}>{sessionCounts[session.address] ?? 0} messages · {active ? 'Current' : formatDate(session.createdAt)}</Text></View>
            <View style={[styles.radioOuter, { borderColor: active ? colors.primary : colors.mutedForeground }]}>{active ? <View style={[styles.radioInner, { backgroundColor: colors.primary }]} /> : null}</View>
          </Pressable>
        );
      }) : <View style={[styles.smallEmpty, { borderColor: colors.border }]}><Feather name="mail" size={17} color={colors.mutedForeground} /><Text style={[styles.smallEmptyText, { color: colors.mutedForeground }]}>Create another address to add a live session.</Text></View>}
      {history.filter((item) => !runtimeSessions.some((session) => session.address === item.address)).length ? (
        <>
          <Text style={[styles.sectionSub, { color: colors.mutedForeground, marginTop: 8 }]}>Past addresses · no longer active</Text>
          {history.filter((item) => !runtimeSessions.some((session) => session.address === item.address)).filter((item) => item.address.toLowerCase().includes(domainSearch.toLowerCase())).slice(0, 8).map((entry, index) => (
            <View key={`${entry.address}-${index}`} style={[styles.sessionRow, { backgroundColor: colors.card, borderColor: colors.border, opacity: 0.7 }]}>
              <View style={[styles.sessionAvatar, { backgroundColor: colors.secondary }]}><Feather name="clock" size={15} color={colors.mutedForeground} /></View>
              <View style={styles.historyCopy}><Text numberOfLines={1} style={[styles.historyTitle, { color: colors.foreground }]}>{entry.address}</Text><Text style={[styles.historySub, { color: colors.mutedForeground }]}>Past address · {formatDate(entry.createdAt)}</Text></View>
            </View>
          ))}
        </>
      ) : null}
    </ScrollView>
  );

  const selectorContent = (
    <View style={styles.selectorBody}>
      <View style={styles.usernameGroup}>
        <View style={styles.usernameLabelRow}>
          <Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>USERNAME</Text>
          <Text style={[styles.optionalLabel, { color: colors.mutedForeground }]}>
            {sessionMode === 'Domain' ? 'OPTIONAL' : 'RANDOM'}
          </Text>
        </View>
        <View style={[styles.usernameField, { backgroundColor: colors.card, borderColor: usernameIsValid ? colors.border : colors.destructive }]}>
          {sessionMode === 'Domain' ? (
            <TextInput
              accessibilityLabel="Optional mailbox username"
              testID="mailbox-username"
              value={requestedUsername}
              onChangeText={setRequestedUsername}
              placeholder="Enter username"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={64}
              style={[styles.usernameInput, { color: colors.foreground }]}
            />
          ) : (
            <Text style={[styles.usernameInput, styles.usernameReadOnly, { color: colors.mutedForeground }]}>random</Text>
          )}
          <Text style={[styles.usernameAt, { color: colors.mutedForeground }]}>@</Text>
          <Text numberOfLines={1} style={[styles.usernameDomain, { color: colors.mutedForeground }]}>
            {selectedDomain ?? 'choose domain'}
          </Text>
        </View>
        <Text style={[styles.usernameHint, { color: usernameIsValid ? colors.mutedForeground : colors.destructive }]}>
          {usernameIsValid
            ? sessionMode === 'Domain'
              ? 'Leave blank to generate a random username.'
              : 'A random username will be generated for this domain.'
            : 'Use 1–64 letters, numbers, dots, underscores, or hyphens.'}
        </Text>
      </View>
      <View style={[styles.segment, { backgroundColor: colors.muted, borderColor: colors.border }]}>
        {(['Random', 'Domain', 'Popular'] as const).map((mode) => (
          <Pressable key={mode} accessibilityRole="button" accessibilityState={{ selected: sessionMode === mode }} testID={`domain-mode-${mode.toLowerCase()}`} onPress={() => {
            setSessionMode(mode);
            if (mode !== 'Domain') setRequestedUsername('');
          }} style={[styles.segmentItem, sessionMode === mode && { backgroundColor: colors.primary }]}>
            <Feather name={mode === 'Random' ? 'shuffle' : mode === 'Domain' ? 'globe' : 'star'} size={13} color={sessionMode === mode ? colors.primaryForeground : colors.mutedForeground} />
            <Text style={[styles.segmentText, { color: sessionMode === mode ? colors.primaryForeground : colors.mutedForeground }]}>{mode}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView style={styles.selectorDomains} keyboardShouldPersistTaps="handled">
        {domains.isLoading ? <View style={[styles.smallEmpty, { borderColor: colors.border }]}><ActivityIndicator size="small" color={colors.primary} /><Text style={[styles.smallEmptyText, { color: colors.mutedForeground }]}>Loading live domains…</Text></View>
          : (
            <View style={styles.domainGrid}>
              {(domains.data?.domains ?? []).map((entry) => (
                <Pressable
                  key={entry.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selectedDomain === entry.domain }}
                  testID={`select-domain-${entry.domain}`}
                  onPress={() => setSelectedDomain(entry.domain)}
                  style={[
                    styles.domainChip,
                    {
                      backgroundColor: selectedDomain === entry.domain ? '#00C875' : colors.card,
                      borderColor: selectedDomain === entry.domain ? '#00C875' : colors.border,
                    },
                  ]}
                >
                  <Text numberOfLines={1} style={[styles.domainChipText, { color: selectedDomain === entry.domain ? '#FFFFFF' : colors.foreground }]}>
                    @{entry.domain}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        {!domains.isLoading && !visibleDomains.length ? <View style={[styles.smallEmpty, { borderColor: colors.border }]}><Text style={[styles.smallEmptyText, { color: colors.mutedForeground }]}>No active domains are available.</Text></View> : null}
        {domains.error ? <Pressable accessibilityRole="button" onPress={() => void domains.refetch()} style={styles.retryDomain}><Text style={[styles.textAction, { color: colors.primary }]}>Retry loading domains</Text></Pressable> : null}
      </ScrollView>
      <View style={styles.selectorSpacer} />
      <Pressable accessibilityRole="button" accessibilityLabel="Create new email and use it now" testID="create-selected-address" disabled={!domains.data?.domains.length || !selectedDomain || (sessionMode === 'Domain' && !usernameIsValid) || createMailbox.isPending} onPress={createSelectedAddress} style={[styles.selectorCreate, { backgroundColor: '#00C875', opacity: createMailbox.isPending || (sessionMode === 'Domain' && !usernameIsValid) ? 0.72 : 1 }]}>
        {createMailbox.isPending ? <ActivityIndicator size="small" color={colors.primaryForeground} /> : <Feather name="plus" size={17} color={colors.primaryForeground} />}
        <View style={styles.selectorCreateCopy}>
          <Text style={[styles.selectorCreateText, { color: '#FFFFFF' }]}>{createMailbox.isPending ? 'CREATING EMAIL…' : 'CREATE NEW EMAIL'}</Text>
          <Text style={[styles.selectorCreateSubtext, { color: '#FFFFFF' }]}>and use it now</Text>
        </View>
      </Pressable>
      {mailboxError ? (
        <View style={[styles.selectorError, { backgroundColor: colors.card, borderColor: colors.destructive }]}>
          <Text style={[styles.errorText, { color: colors.destructive }]}>{mailboxError}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry creating the mailbox" testID="retry-selected-address" onPress={createSelectedAddress} style={styles.retryMailbox}>
            <Text style={[styles.textAction, { color: colors.primary }]}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  const otherContent = (
    <ScrollView contentContainerStyle={[styles.page, { paddingBottom: dockBottom + 104 }]} showsVerticalScrollIndicator={false}>
      <View style={styles.profileCard}>
        <View style={[styles.profileAvatar, { backgroundColor: colors.primary }]}><Feather name="user" size={21} color={colors.primaryForeground} /></View>
        <View style={styles.historyCopy}><Text style={[styles.profileTitle, { color: colors.foreground }]}>Guest</Text><Text style={[styles.historySub, { color: colors.mutedForeground }]}>Ready to receive mail</Text></View>
        <View style={[styles.readyPill, { backgroundColor: colors.accent }]}><View style={[styles.readyDot, { backgroundColor: colors.primary }]} /><Text style={[styles.readyLabel, { color: colors.accentForeground }]}>READY</Text></View>
      </View>
      <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Preferences</Text>
      <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <SettingRow icon={preferences.darkMode ? 'moon' : 'sun'} title="Dark mode" subtitle="Use the darker inbox appearance" value={preferences.darkMode} onValueChange={(value) => setPreferences((p) => ({ ...p, darkMode: value }))} testID="setting-dark-mode" colors={colors} />
        <View style={[styles.hairline, { backgroundColor: colors.border }]} />
        <SettingRow icon="refresh-cw" title="Auto-refresh" subtitle="Check for new mail every 4.5 seconds" value={preferences.autoRefresh} onValueChange={(value) => setPreferences((p) => ({ ...p, autoRefresh: value }))} testID="setting-auto-refresh" colors={colors} />
        <View style={[styles.hairline, { backgroundColor: colors.border }]} />
        <SettingRow icon="activity" title="Haptic feedback" subtitle="Light feedback for key actions" value={preferences.haptics} onValueChange={(value) => setPreferences((p) => ({ ...p, haptics: value }))} testID="setting-haptics" colors={colors} />
        <View style={[styles.hairline, { backgroundColor: colors.border }]} />
        <SettingAction icon="globe" title="Language" subtitle={language} testID="setting-language" onPress={() => Alert.alert('Language', 'Choose your display language.', [
          { text: 'English', onPress: () => setLanguage('English') },
          { text: 'Spanish', onPress: () => setLanguage('Spanish') },
          { text: 'Cancel', style: 'cancel' },
        ])} colors={colors} />
        <View style={[styles.hairline, { backgroundColor: colors.border }]} />
        <SettingAction icon="refresh-cw" title="Check for updates" subtitle="Instant Mail is up to date" testID="setting-updates" onPress={() => Alert.alert('You’re up to date', 'You are using the latest version of Instant Mail.')} colors={colors} />
      </View>
      <Text style={[styles.sectionTitle, { color: colors.foreground, marginTop: 12 }]}>Information</Text>
      <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <SettingAction icon="shield" title="Privacy" subtitle="How your mailbox data is handled" testID="setting-privacy" onPress={() => Alert.alert('Privacy', 'Address history, saved messages, and the active mailbox session are stored on this device so your inbox can reopen after refresh.')} colors={colors} />
        <View style={[styles.hairline, { backgroundColor: colors.border }]} />
        <SettingAction icon="file-text" title="Terms" subtitle="Temporary email usage" testID="setting-terms" onPress={() => Alert.alert('Terms', 'Temporary addresses expire and should not be used for important accounts.')} colors={colors} />
        <View style={[styles.hairline, { backgroundColor: colors.border }]} />
        <SettingAction icon="bell" title="Latest updates" subtitle="What’s new in Instant Mail" testID="setting-latest-updates" onPress={() => Alert.alert('Latest updates', 'Your inbox now checks for new messages quietly in the background.')} colors={colors} />
      </View>
      <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border, marginTop: 15 }]}>
        <SettingAction icon="clock" title="Clear address history" subtitle={`${history.length} stored addresses`} testID="settings-clear-history" onPress={clearHistory} colors={colors} />
        <View style={[styles.hairline, { backgroundColor: colors.border }]} />
        <SettingAction icon="bookmark" title="Clear saved messages" subtitle={`${savedMessages.length} saved snapshots`} testID="settings-clear-saved" onPress={clearSaved} colors={colors} />
      </View>
      {savedMessages.length ? (
        <>
          <View style={styles.historySectionHead}>
            <View><Text style={[styles.sectionTitle, { color: colors.foreground }]}>Saved messages</Text><Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>Stored only on this device.</Text></View>
            <Pressable accessibilityRole="button" accessibilityLabel="Clear saved messages" testID="clear-saved" onPress={clearSaved}><Text style={[styles.textAction, { color: colors.destructive }]}>Clear</Text></Pressable>
          </View>
          {savedMessages.map((entry) => <Pressable key={entry.message.id} accessibilityRole="button" accessibilityLabel={`Open saved message ${entry.message.subject}`} testID={`saved-${entry.message.id}`} onPress={() => openSaved(entry)} style={[styles.historyRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.historyIcon, { backgroundColor: colors.accent }]}><Feather name="bookmark" size={16} color={colors.primary} /></View>
            <View style={styles.historyCopy}><Text numberOfLines={1} style={[styles.historyTitle, { color: colors.foreground }]}>{entry.message.subject || '(no subject)'}</Text><Text numberOfLines={1} style={[styles.historySub, { color: colors.mutedForeground }]}>{entry.message.from.name || entry.message.from.address}</Text></View>
            <Text style={[styles.date, { color: colors.mutedForeground }]}>{formatDate(entry.savedAt)}</Text>
          </Pressable>)}
        </>
      ) : null}
      <Text style={[styles.versionText, { color: colors.mutedForeground }]}>INSTANT MAIL</Text>
    </ScrollView>
  );

  const emailContent = (
    <ScrollView contentContainerStyle={[styles.homePage, { paddingBottom: dockBottom + 105 }]} showsVerticalScrollIndicator={false}>
      <Text style={[styles.homeSubtitle, { color: colors.mutedForeground }]}>Your temporary email address</Text>
      <View style={[styles.homeAddressCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[styles.envelopeGlow, { backgroundColor: colors.accent, borderColor: colors.primary }]}>
          <Feather name="mail" size={31} color={colors.primary} />
        </View>
        <Text style={[styles.address, styles.homeAddress, { color: colors.foreground }]} selectable numberOfLines={2}>
          {address ?? (mailboxError ? 'Email address unavailable' : 'Creating your address…')}
        </Text>
        {address ? (
          <View style={[styles.domainPill, { backgroundColor: colors.accent }]}>
            <Feather name={sessionMode === 'Random' ? 'shuffle' : 'globe'} size={12} color={colors.primary} />
            <Text style={[styles.domainPillText, { color: colors.accentForeground }]}>{sessionMode === 'Random' ? 'Random' : sessionMode === 'Popular' ? 'Popular' : 'Domain'} · {address.split('@')[1]}</Text>
          </View>
        ) : !mailboxError ? <View style={styles.addressShimmer} testID="initial-address-shimmer"><View style={[styles.shimmerBar, { backgroundColor: colors.secondary, width: 130 }]} /></View> : null}
        {createMailbox.isPending && address ? (
          <View style={styles.inlineRoll} accessibilityLiveRegion="polite" testID="address-roll-shimmer">
            <View style={[styles.shimmerBar, { backgroundColor: colors.accent, width: 54 }]} />
            <Text style={[styles.shimmerText, { color: colors.primary }]}>Preparing a fresh address</Text>
          </View>
        ) : null}
        {!address && mailboxError ? (
          <View style={styles.errorCard}>
            <Text style={[styles.errorText, { color: colors.destructive }]}>{mailboxError}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Retry mailbox creation" testID="retry-setup" onPress={retryInitialSetup} style={styles.retryMailbox}>
              <Feather name="rotate-cw" size={14} color={colors.primary} />
              <Text style={[styles.textAction, { color: colors.primary }]}>Retry</Text>
            </Pressable>
          </View>
        ) : null}
        <View style={[styles.caution, { backgroundColor: colors.muted }]}>
          <Feather name="alert-circle" size={15} color={colors.mutedForeground} />
          <Text style={[styles.cautionText, { color: colors.mutedForeground }]}>Email address is randomly generated, expires in about 2 days and cannot be restored. Please do not use for important accounts</Text>
        </View>
      </View>
      <View style={styles.homeActions}>
        <Pressable accessibilityRole="button" accessibilityLabel="Copy email address to clipboard" testID="copy-address" disabled={!address} onPress={() => address && void handleCopy(address, 'Copied to clipboard!')} style={[styles.copyCta, { backgroundColor: colors.primary, opacity: address ? 1 : 0.5 }]}>
          <Feather name="copy" size={16} color={colors.primaryForeground} /><Text style={[styles.copyCtaText, { color: colors.primaryForeground }]}>COPY TO CLIPBOARD</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Get a new email address" testID="generate-address" disabled={createMailbox.isPending} onPress={handleNewAddress} style={[styles.newCta, { borderColor: colors.border, backgroundColor: colors.card, opacity: createMailbox.isPending ? 0.72 : 1 }]}>
          {createMailbox.isPending ? <ActivityIndicator size="small" color={colors.primary} /> : <Feather name="shuffle" size={16} color={colors.primary} />}
          <Text style={[styles.newCtaText, { color: colors.foreground }]}>GET A NEW EMAIL ADDRESS</Text>
        </Pressable>
      </View>
      <View style={[styles.emailStatus, { borderColor: colors.border }]}>
        <Animated.View style={[styles.livePulse, { backgroundColor: colors.primary, opacity: pulse, transform: [{ scale: pulse }] }]} />
        <Text style={[styles.emailStatusText, { color: colors.mutedForeground }]}>{preferences.autoRefresh ? 'Ready to receive · Listening quietly' : 'Ready to receive · Auto-refresh paused'}</Text>
      </View>
    </ScrollView>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <StatusBar style="light" />
      <NativeStatusBar backgroundColor="#00C875" barStyle="light-content" />
      <View style={[styles.appBar, { backgroundColor: '#00C875', height: 56 + topInset, paddingTop: topInset }]}>
        <Text style={styles.appBarTitle}>Instant Mail</Text>
        <View style={styles.appBarActions}>
          <Pressable accessibilityRole="button" accessibilityLabel="Choose language" testID="top-language" onPress={() => Alert.alert('Language', 'Choose your display language.', [
            { text: 'English', onPress: () => setLanguage('English') },
            { text: 'Spanish', onPress: () => setLanguage('Spanish') },
            { text: 'Cancel', style: 'cancel' },
          ])} style={styles.appBarButton}><Feather name="globe" size={18} color="#FFFFFF" /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={preferences.darkMode ? 'Switch to light mode' : 'Switch to dark mode'} testID="top-theme-toggle" onPress={() => setPreferences((p) => ({ ...p, darkMode: !p.darkMode }))} style={styles.appBarButton}><Feather name={preferences.darkMode ? 'sun' : 'moon'} size={18} color="#FFFFFF" /></Pressable>
        </View>
      </View>
      <View style={styles.main}>
        {createMailbox.isPending ? (
          <View style={[styles.globalRoll, { backgroundColor: colors.accent }]} accessibilityLiveRegion="polite" testID="mailbox-create-progress">
            <ActivityIndicator size="small" color={colors.primary} />
            <View style={styles.globalRollCopy}>
              <View style={[styles.shimmerBar, { backgroundColor: colors.secondary, width: 126 }]} />
              <Text style={[styles.shimmerText, { color: colors.accentForeground }]}>Creating your new address…</Text>
            </View>
          </View>
        ) : null}
        {screen === 'email' ? emailContent : screen === 'inbox' ? (
          <FlatList
            data={messages.data?.messages ?? []}
            keyExtractor={(item) => item.id}
            ListHeaderComponent={header}
            ListEmptyComponent={emptyComponent}
            renderItem={renderMessage}
            contentContainerStyle={[styles.page, styles.inboxList, { paddingBottom: dockBottom + 105 }]}
            showsVerticalScrollIndicator={false}
            scrollEnabled={Boolean(messages.data?.messages.length)}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => {
              setRefreshing(true);
              void messages.refetch().finally(() => setRefreshing(false));
            }} tintColor={colors.cyan} colors={[colors.cyan]} />}
          />
        ) : screen === 'switch' ? switchContent : otherContent}
      </View>

      <View pointerEvents="box-none" onLayout={(event) => setDockWidth(event.nativeEvent.layout.width)} style={[styles.dockWrap, { paddingBottom: bottomInset, backgroundColor: colors.background, borderColor: colors.border }]}>
        <View style={[styles.dock, { backgroundColor: colors.background }]}>
          <Animated.View style={[styles.activePill, {
            backgroundColor: colors.accent,
            transform: [{ translateX: dockProgress.interpolate({ inputRange: [0, 1, 2, 3], outputRange: [0, dockWidth / 4, dockWidth / 2, dockWidth * 0.75] }) }],
          }]} />
          <DockItem icon="mail" label="Email" active={screen === 'email'} color={colors.primary} muted={colors.mutedForeground} testID="dock-email" onPress={() => switchScreen('email')} />
          <DockItem icon="inbox" label="Inbox" badge={messages.data?.totalItems} badgeTextColor={colors.primaryForeground} active={screen === 'inbox'} color={colors.primary} muted={colors.mutedForeground} testID="dock-inbox" onPress={() => switchScreen('inbox')} />
          <DockItem icon="shuffle" label="Switch Email" active={screen === 'switch'} color={colors.primary} muted={colors.mutedForeground} testID="dock-switch-email" onPress={() => switchScreen('switch')} />
          <DockItem icon="more-horizontal" label="Other" active={screen === 'other'} color={colors.primary} muted={colors.mutedForeground} testID="dock-other" onPress={() => switchScreen('other')} />
        </View>
      </View>

      <Modal
        visible={selectorVisible}
        transparent
        animationType="slide"
        statusBarTranslucent
        presentationStyle="overFullScreen"
        onRequestClose={() => setSelectorVisible(false)}
      >
        <View style={styles.selectorOverlay}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close address selector"
            testID="close-address-selector-backdrop"
            onPress={() => setSelectorVisible(false)}
            style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.64)' }]}
          />
          <View
            accessibilityViewIsModal
            testID="address-selector"
            style={[
              styles.selectorSheet,
              {
                backgroundColor: colors.background,
                borderColor: colors.border,
                paddingBottom: Math.max(bottomInset, 14),
              },
            ]}
          >
            <View style={styles.selectorSheetHeader}>
              <View style={styles.sheetHandle}>
                <View style={[styles.handleBar, { backgroundColor: colors.mutedForeground }]} />
              </View>
              <Text style={[styles.selectorPageTitle, { color: colors.foreground }]}>GET A NEW EMAIL ADDRESS</Text>
              <Text style={[styles.selectorPageSubtitle, { color: colors.mutedForeground }]}>Choose the type of email you want to create.</Text>
            </View>
            <View style={styles.selectorContent}>
              {selectorContent}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel creating a new address"
              testID="cancel-address-selector"
              onPress={() => setSelectorVisible(false)}
              style={[styles.selectorCancel, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Text style={[styles.selectorCancelText, { color: colors.destructive }]}>CANCEL</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {selectedMessage ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <Animated.View style={[styles.sheetBackdrop, { opacity: sheetOpacity, backgroundColor: colors.background }]}>
            <Pressable accessibilityRole="button" accessibilityLabel="Close message" testID="message-sheet-backdrop" style={StyleSheet.absoluteFill} onPress={closeMessage} />
          </Animated.View>
          <Animated.View
            accessibilityViewIsModal
            testID="message-detail-sheet"
            style={[styles.sheet, {
              backgroundColor: colors.card,
              borderColor: colors.border,
              paddingBottom: Math.max(bottomInset, 18),
              transform: [{ translateY: sheetY }],
              opacity: sheetOpacity,
            }]}
          >
            <View style={styles.sheetHandle}><View style={[styles.handleBar, { backgroundColor: colors.mutedForeground }]} /></View>
            <View style={styles.sheetTopbar}>
              <Pressable accessibilityRole="button" accessibilityLabel="Close message" testID="close-message" onPress={closeMessage} style={styles.sheetIconButton}><Feather name="x" size={20} color={colors.foreground} /></Pressable>
              <Text style={[styles.sheetKicker, { color: colors.mutedForeground }]}>MESSAGE DETAILS</Text>
              <View style={styles.sheetActions}>
                <Pressable accessibilityRole="button" accessibilityLabel="Save message" testID="save-message" onPress={saveSnapshot} style={styles.sheetIconButton}><Feather name="bookmark" size={18} color={savedMessages.some((entry) => entry.message.id === selectedMessage.id) ? colors.cyan : colors.foreground} /></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Delete email" testID="delete-email" disabled={deleteMessage.isPending || Boolean(savedSelection)} onPress={handleDelete} style={styles.sheetIconButton}>
                  {deleteMessage.isPending ? <ActivityIndicator size="small" color={colors.destructive} /> : <Feather name="trash-2" size={18} color={savedSelection ? colors.mutedForeground : colors.destructive} />}
                </Pressable>
              </View>
            </View>
            <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent} showsVerticalScrollIndicator={false}>
              <View style={styles.senderDetail}>
                <View style={[styles.avatarLarge, { backgroundColor: colors.accent }]}><Text style={[styles.avatarText, { color: colors.cyan }]}>{initials(selectedMessage.from.name || selectedMessage.from.address)}</Text></View>
                <View style={styles.senderDetailCopy}>
                  <Text numberOfLines={1} style={[styles.senderDetailName, { color: colors.foreground }]}>{selectedMessage.from.name || selectedMessage.from.address}</Text>
                  <Text numberOfLines={1} style={[styles.senderAddress, { color: colors.mutedForeground }]}>{selectedMessage.from.address}</Text>
                </View>
                <Text style={[styles.date, { color: colors.mutedForeground }]}>{formatDate(selectedMessage.createdAt)}</Text>
              </View>
              <Text style={[styles.detailSubject, { color: colors.foreground }]}>{selectedMessage.subject || '(no subject)'}</Text>
              <Text style={[styles.toLine, { color: colors.mutedForeground }]}>To {messageDetail.data?.to.map((recipient) => recipient.address).join(', ') || address}</Text>
              {messageOtp ? (
                <Pressable accessibilityRole="button" accessibilityLabel={`Copy verification code ${messageOtp}`} testID="copy-otp" onPress={() => void handleCopy(messageOtp, 'Code copied')} style={[styles.otpCard, { borderColor: colors.cyan, backgroundColor: colors.accent }]}>
                  <View><Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>VERIFICATION CODE</Text><Text style={[styles.otpValue, { color: colors.cyan }]}>{messageOtp}</Text></View>
                  <Feather name="copy" size={17} color={colors.cyan} />
                </Pressable>
              ) : null}
              <View style={[styles.bodyCard, { backgroundColor: colors.glass, borderColor: colors.border }]}>
                {messageDetail.isLoading && !savedSelection ? (
                  <View style={styles.bodyLoading} testID="message-body-loading">
                    <Text style={[styles.bodyText, { color: colors.foreground }]}>{selectedMessage.intro || 'Loading full message…'}</Text>
                    <View style={[styles.shimmerBar, { backgroundColor: colors.secondary, width: '70%' }]} />
                    <View style={[styles.shimmerBar, { backgroundColor: colors.secondary, width: '94%' }]} />
                  </View>
                ) : messageDetail.error && !savedSelection ? (
                  <View style={styles.bodyError}>
                    <Text style={[styles.bodyText, { color: colors.mutedForeground }]}>{selectedMessage.intro || readableError(messageDetail.error)}</Text>
                    <Pressable accessibilityRole="button" testID="retry-message-detail" onPress={() => void messageDetail.refetch()}><Text style={[styles.textAction, { color: colors.cyan }]}>Retry loading</Text></Pressable>
                  </View>
                ) : (
                  <Text selectable style={[styles.bodyText, { color: colors.foreground }]}>{selectedBody || selectedMessage.intro || 'This message has no readable body.'}</Text>
                )}
              </View>
              {savedSelection ? <Text style={[styles.savedNote, { color: colors.mutedForeground }]}>Saved snapshot · {formatDate(savedSelection.savedAt)}</Text> : null}
            </ScrollView>
          </Animated.View>
        </View>
      ) : null}

      {toast ? (
        <View
          accessibilityLiveRegion="polite"
          pointerEvents="none"
          style={[styles.toast, {
            bottom: dockBottom + 88,
            backgroundColor: toastTone === 'success'
              ? '#0C9F65'
              : toastTone === 'error' ? colors.destructive : colors.secondary,
            borderColor: toastTone === 'info' ? colors.border : 'transparent',
          }]}
        >
          <Feather
            name={toastTone === 'error' ? 'alert-circle' : 'check-circle'}
            size={15}
            color={toastTone === 'info' ? colors.cyan : '#FFFFFF'}
          />
          <Text style={[styles.toastText, { color: toastTone === 'info' ? colors.foreground : '#FFFFFF' }]}>{toast}</Text>
        </View>
      ) : null}
    </View>
  );
}

function DockItem({ icon, label, active, color, muted, testID, onPress, busy = false, badge, badgeTextColor }: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  active: boolean;
  color: string;
  muted: string;
  testID: string;
  onPress: () => void;
  busy?: boolean;
  badge?: number;
  badgeTextColor?: string;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active }} testID={testID} onPress={onPress} style={styles.dockItem}>
      <View style={styles.dockIconWrap}>
        {busy ? <ActivityIndicator size="small" color={color} /> : <Feather name={icon} size={19} color={active ? color : muted} />}
        {badge ? <View style={[styles.dockBadge, { backgroundColor: color }]}><Text style={[styles.dockBadgeText, { color: badgeTextColor }]}>{badge > 99 ? '99+' : badge}</Text></View> : null}
      </View>
      <Text numberOfLines={1} style={[styles.dockLabel, { color: active ? color : muted, fontWeight: active ? '700' : '500' }]}>{label}</Text>
    </Pressable>
  );
}

function MessageCard({ item, isNew, colors, onPress }: {
  item: MailMessageSummary;
  isNew: boolean;
  colors: AppColors;
  onPress: () => void;
}) {
  const appear = useRef(new Animated.Value(isNew ? 0 : 1)).current;
  useEffect(() => {
    if (!isNew) return;
    appear.setValue(0);
    Animated.timing(appear, { toValue: 1, duration: 360, useNativeDriver: true }).start();
  }, [appear, isNew]);
  const style = {
    opacity: appear,
    transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
  };
  const code = otpFrom(`${item.subject} ${item.intro}`);
  return (
    <Animated.View style={style}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open email from ${item.from.name || item.from.address}, ${item.subject || 'no subject'}`}
        testID={`message-${item.id}`}
        onPress={onPress}
        style={({ pressed }) => [
          styles.messageCard,
          { backgroundColor: colors.glass, borderColor: isNew ? colors.cyan : colors.border, opacity: pressed ? 0.84 : 1 },
        ]}
      >
        <View style={[styles.avatar, { backgroundColor: colors.accent }]}>
          <Text style={[styles.avatarText, { color: colors.accentForeground }]}>{initials(item.from.name || item.from.address)}</Text>
        </View>
        <View style={styles.messageCopy}>
          <View style={styles.senderLine}>
            <Text numberOfLines={1} style={[styles.sender, { color: colors.foreground, fontWeight: item.seen ? '500' : '700' }]}>
              {item.from.name || item.from.address}
            </Text>
            {isNew ? <View style={[styles.newBadge, { backgroundColor: colors.cyan }]}><Text style={[styles.newBadgeText, { color: colors.primaryForeground }]}>NEW</Text></View> : null}
            {!item.seen && !isNew ? <View style={[styles.unreadDot, { backgroundColor: colors.cyan }]} /> : null}
          </View>
          <Text numberOfLines={1} style={[styles.senderAddress, { color: colors.mutedForeground }]}>{item.from.address}</Text>
          <Text numberOfLines={1} style={[styles.subject, { color: colors.foreground }]}>{item.subject || '(no subject)'}</Text>
          <Text numberOfLines={2} style={[styles.intro, { color: colors.mutedForeground }]}>{item.intro || 'Open to read this email.'}</Text>
          {code ? <View style={[styles.codeTag, { borderColor: colors.cyan }]}><Feather name="key" size={11} color={colors.cyan} /><Text style={[styles.codeTagText, { color: colors.cyan }]}>{code}</Text></View> : null}
        </View>
        <View style={styles.messageMeta}>
          <Text style={[styles.date, { color: colors.mutedForeground }]}>{formatDate(item.createdAt)}</Text>
          <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
        </View>
      </Pressable>
    </Animated.View>
  );
}

function SettingRow({ icon, title, subtitle, value, onValueChange, testID, colors }: {
  icon: React.ComponentProps<typeof Feather>['name'];
  title: string;
  subtitle: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  testID: string;
  colors: AppColors;
}) {
  return (
    <View style={styles.settingRow}>
      <View style={[styles.settingIcon, { backgroundColor: colors.accent }]}><Feather name={icon} size={16} color={colors.cyan} /></View>
      <View style={styles.settingCopy}><Text style={[styles.settingTitle, { color: colors.foreground }]}>{title}</Text><Text style={[styles.settingSub, { color: colors.mutedForeground }]}>{subtitle}</Text></View>
      <Switch accessibilityLabel={title} testID={testID} value={value} onValueChange={onValueChange} trackColor={{ false: colors.secondary, true: colors.cyan }} thumbColor={value ? colors.background : colors.mutedForeground} />
    </View>
  );
}

function SettingAction({ icon, title, subtitle, destructive = false, testID, onPress, colors }: {
  icon: React.ComponentProps<typeof Feather>['name'];
  title: string;
  subtitle: string;
  destructive?: boolean;
  testID: string;
  onPress: () => void;
  colors: AppColors;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} testID={testID} onPress={onPress} style={styles.settingRow}>
      <View style={[styles.settingIcon, { backgroundColor: colors.accent }]}><Feather name={icon} size={16} color={destructive ? colors.destructive : colors.primary} /></View>
      <View style={styles.settingCopy}><Text style={[styles.settingTitle, { color: destructive ? colors.destructive : colors.foreground }]}>{title}</Text><Text style={[styles.settingSub, { color: colors.mutedForeground }]}>{subtitle}</Text></View>
      <Feather name="chevron-right" size={17} color={colors.mutedForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, minHeight: '100%' },
  appBar: { height: 56, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  appBarTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '700', letterSpacing: -0.2 },
  appBarActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  appBarButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  main: { flex: 1 },
  globalRoll: { minHeight: 48, marginHorizontal: 20, marginTop: 8, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  globalRollCopy: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ambient: { ...StyleSheet.absoluteFill, overflow: 'hidden' },
  page: { width: '100%', maxWidth: 620, alignSelf: 'center', paddingHorizontal: 21, paddingTop: 10, gap: 14 },
  homePage: { width: '100%', maxWidth: 620, alignSelf: 'center', flexGrow: 1, paddingHorizontal: 21, paddingTop: 25, paddingBottom: 24, gap: 17, justifyContent: 'center' },
  homeSubtitle: { fontSize: 14, fontWeight: '500', textAlign: 'center', marginBottom: 1 },
  homeAddressCard: { borderRadius: 23, borderWidth: 1, padding: 22, alignItems: 'center', gap: 15, shadowOpacity: 0.07, shadowRadius: 16, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
  envelopeGlow: { width: 76, height: 76, borderRadius: 23, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  homeAddress: { fontSize: 18, lineHeight: 25, fontWeight: '700', textAlign: 'center', letterSpacing: -0.25, maxWidth: '100%' },
  domainPill: { borderRadius: 14, minHeight: 31, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  domainPillText: { fontSize: 11, fontWeight: '600' },
  caution: { width: '100%', borderRadius: 13, padding: 12, flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 4 },
  cautionText: { flex: 1, fontSize: 10, lineHeight: 15 },
  homeActions: { gap: 10 },
  copyCta: { height: 51, borderRadius: 15, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 9 },
  copyCtaText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.4 },
  newCta: { height: 51, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 9 },
  newCtaText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.25 },
  emailStatus: { minHeight: 36, borderTopWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 9 },
  emailStatusText: { fontSize: 10 },
  inboxList: { flexGrow: 1 },
  listHeader: { gap: 10, paddingBottom: 2 },
  topline: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  brandMark: { width: 37, height: 37, borderWidth: 1, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  brandName: { fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  brandCaption: { fontSize: 8, letterSpacing: 1.1, marginLeft: 2, fontWeight: '700' },
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 7, borderWidth: 1, borderRadius: 30, paddingHorizontal: 10, paddingVertical: 7 },
  livePulse: { width: 7, height: 7, borderRadius: 4 },
  liveLabel: { fontSize: 9, letterSpacing: 1.05, fontWeight: '700' },
  titleBlock: { gap: 8, paddingTop: 6, paddingBottom: 2 },
  title: { fontSize: 34, lineHeight: 39, fontWeight: '700', letterSpacing: -1.15 },
  subtitle: { fontSize: 13, lineHeight: 19, maxWidth: 310 },
  addressCard: { borderRadius: 24, borderWidth: 1, padding: 15, gap: 13, shadowOpacity: 0.06, shadowRadius: 22, shadowOffset: { width: 0, height: 5 }, elevation: 2 },
  addressUpper: { flexDirection: 'row', gap: 11, alignItems: 'center' },
  addressIcon: { width: 39, height: 39, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  addressInfo: { flex: 1, gap: 5 },
  eyebrow: { fontSize: 9, letterSpacing: 1.15, fontWeight: '700' },
  address: { fontSize: 15, lineHeight: 19, fontWeight: '600', letterSpacing: -0.2 },
  addressShimmer: { gap: 5 },
  inlineRoll: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 2 },
  shimmerBar: { height: 8, borderRadius: 8 },
  shimmerText: { fontSize: 11 },
  iconAction: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  hairline: { height: StyleSheet.hairlineWidth },
  addressLower: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  refreshStatus: { flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1 },
  refreshLabel: { fontSize: 11 },
  rollButton: { borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center' },
  rollText: { fontSize: 12, fontWeight: '700' },
  errorCard: { borderWidth: 1, borderRadius: 17, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 10 },
  errorText: { flex: 1, fontSize: 12, lineHeight: 17 },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8 },
  sectionTitle: { fontSize: 17, fontWeight: '700', letterSpacing: -0.25 },
  sectionSub: { marginTop: 4, fontSize: 11 },
  refreshButton: { width: 38, height: 38, borderWidth: 1, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  messageCard: { flexDirection: 'row', gap: 11, alignItems: 'flex-start', borderWidth: 1, borderRadius: 21, padding: 13, marginTop: 10 },
  avatar: { width: 39, height: 39, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },
  messageCopy: { flex: 1, gap: 3, minWidth: 0 },
  senderLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  sender: { fontSize: 12, flexShrink: 1 },
  senderAddress: { fontSize: 10 },
  subject: { fontSize: 13, fontWeight: '600', marginTop: 2 },
  intro: { fontSize: 11, lineHeight: 16 },
  messageMeta: { alignItems: 'flex-end', gap: 11, paddingTop: 2 },
  date: { fontSize: 10 },
  unreadDot: { width: 6, height: 6, borderRadius: 3 },
  newBadge: { borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2 },
  newBadgeText: { fontSize: 8, fontWeight: '800', letterSpacing: 0.6 },
  codeTag: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 4, marginTop: 4 },
  codeTagText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  emptyState: { marginTop: 14, minHeight: 220, borderWidth: 1, borderRadius: 24, alignItems: 'center', justifyContent: 'center', padding: 25, gap: 9 },
  emptyIcon: { width: 48, height: 48, borderRadius: 17, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  emptyTitle: { fontSize: 16, fontWeight: '700' },
  emptyCopy: { fontSize: 12, lineHeight: 18, textAlign: 'center', maxWidth: 250 },
  waitingChip: { borderWidth: 1, borderRadius: 18, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 11, paddingVertical: 7, marginTop: 6 },
  waitingText: { fontSize: 10 },
  retryAction: { marginTop: 6, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12 },
  retryText: { fontSize: 12, fontWeight: '600' },
  skeletonStack: { gap: 9, paddingTop: 12 },
  skeletonCard: { borderRadius: 19, borderWidth: 1, padding: 14, flexDirection: 'row', gap: 12, alignItems: 'center' },
  skeletonCircle: { width: 38, height: 38, borderRadius: 14 },
  skeletonLines: { flex: 1, gap: 8 },
  screenTitle: { fontSize: 29, lineHeight: 35, fontWeight: '700', letterSpacing: -0.8, marginTop: 5 },
  countBubble: { width: 36, height: 36, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  countText: { fontSize: 13, fontWeight: '700' },
  countInline: { fontSize: 12, fontWeight: '500' },
  historySectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 15 },
  historyRow: { minHeight: 65, borderRadius: 18, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 11 },
  historyIcon: { width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  historyCopy: { flex: 1, minWidth: 0, gap: 4 },
  historyTitle: { fontSize: 12, fontWeight: '600' },
  historySub: { fontSize: 10 },
  smallEmpty: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 17, minHeight: 54, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 9 },
  smallEmptyText: { fontSize: 11 },
  textAction: { fontSize: 12, fontWeight: '700' },
  clearSaved: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 15, marginTop: 8 },
  clearSavedText: { fontSize: 12, fontWeight: '600' },
  settingsCard: { borderWidth: 1, borderRadius: 22, paddingHorizontal: 13, paddingVertical: 3 },
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 70, paddingVertical: 9 },
  settingIcon: { width: 35, height: 35, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  settingCopy: { flex: 1, gap: 4 },
  settingTitle: { fontSize: 13, fontWeight: '600' },
  settingSub: { fontSize: 10, lineHeight: 14 },
  privacyNote: { marginTop: 19, borderWidth: 1, borderRadius: 18, padding: 14, flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  privacyText: { flex: 1, fontSize: 11, lineHeight: 16 },
  versionText: { alignSelf: 'center', marginTop: 22, fontSize: 8, letterSpacing: 1.4, fontWeight: '700' },
  dockWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'stretch', borderTopWidth: 1 },
  dock: { height: 68, width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingHorizontal: 0 },
  activePill: { position: 'absolute', left: 0, top: 5, width: '25%', height: 56, borderRadius: 18 },
  dockItem: { width: '25%', height: 60, alignItems: 'center', justifyContent: 'center', gap: 3, zIndex: 1 },
  dockIconWrap: { position: 'relative', alignItems: 'center', justifyContent: 'center', height: 23 },
  dockBadge: { position: 'absolute', minWidth: 14, height: 14, paddingHorizontal: 3, borderRadius: 7, top: -5, right: -10, alignItems: 'center', justifyContent: 'center' },
  dockBadgeText: { fontSize: 8, fontWeight: '800' },
  dockLabel: { fontSize: 9 },
  switchTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  quickAdd: { width: 42, height: 42, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  searchBox: { borderWidth: 1, minHeight: 47, borderRadius: 15, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 13 },
  searchInput: { flex: 1, fontSize: 13, paddingVertical: 8 },
  segment: { borderWidth: 1, borderRadius: 15, padding: 4, flexDirection: 'row', gap: 4 },
  selectorOverlay: { flex: 1, justifyContent: 'flex-end' },
  selectorSheet: { width: '100%', height: '88%', maxHeight: 760, borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: 1, paddingTop: 5, paddingHorizontal: 20, overflow: 'hidden' },
  selectorSheetHeader: { alignItems: 'center', gap: 6, paddingTop: 4, paddingBottom: 14 },
  selectorPageTitle: { fontSize: 17, fontWeight: '800', textAlign: 'center', letterSpacing: 0.25 },
  selectorPageSubtitle: { fontSize: 12, textAlign: 'center' },
  selectorContent: { flex: 1, minHeight: 0 },
  selectorBody: { flex: 1, gap: 13, paddingBottom: 12 },
  usernameGroup: { gap: 7 },
  usernameLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  optionalLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0.8 },
  usernameField: { minHeight: 48, borderWidth: 1, borderRadius: 14, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  usernameInput: { flex: 1, minWidth: 80, fontSize: 14, paddingVertical: 10 },
  usernameReadOnly: { textAlignVertical: 'center' },
  usernameAt: { fontSize: 14, paddingHorizontal: 5 },
  usernameDomain: { maxWidth: '42%', fontSize: 11, fontWeight: '600' },
  usernameHint: { fontSize: 10, lineHeight: 15 },
  selectorDomains: { flex: 1, minHeight: 100 },
  domainGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignContent: 'flex-start' },
  domainChip: { width: '47%', minHeight: 40, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8, alignItems: 'center', justifyContent: 'center' },
  domainChipText: { fontSize: 11, fontWeight: '600' },
  selectorSpacer: { flex: 1, minHeight: 8 },
  selectorCreate: { minHeight: 70, borderRadius: 15, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 9 },
  selectorCreateText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.25 },
  selectorCreateCopy: { alignItems: 'center', justifyContent: 'center', gap: 2 },
  selectorCreateSubtext: { fontSize: 10, fontWeight: '500' },
  selectorCancel: { minHeight: 52, borderWidth: 1, borderRadius: 14, marginTop: 11, alignItems: 'center', justifyContent: 'center' },
  selectorCancelText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.35 },
  selectorError: { borderWidth: 1, borderRadius: 13, minHeight: 46, paddingHorizontal: 10, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
  retryMailbox: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 6, paddingVertical: 7 },
  segmentItem: { flex: 1, minHeight: 38, borderRadius: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  segmentText: { fontSize: 11, fontWeight: '700' },
  modeCard: { borderWidth: 1, borderRadius: 18, minHeight: 65, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  modeIcon: { width: 35, height: 35, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  domainList: { gap: 8 },
  domainRow: { minHeight: 53, borderWidth: 1, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10 },
  domainText: { flex: 1, fontSize: 12, fontWeight: '600' },
  retryDomain: { alignItems: 'center', padding: 12 },
  sessionRow: { borderWidth: 1, borderRadius: 17, minHeight: 63, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 11, paddingVertical: 9 },
  sessionAvatar: { width: 36, height: 36, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  sessionAvatarText: { fontSize: 11, fontWeight: '700' },
  radioOuter: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  radioInner: { width: 9, height: 9, borderRadius: 5 },
  profileCard: { minHeight: 76, borderRadius: 20, backgroundColor: 'transparent', flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  profileAvatar: { width: 48, height: 48, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  profileTitle: { fontSize: 15, fontWeight: '700' },
  readyPill: { borderRadius: 12, paddingHorizontal: 9, paddingVertical: 6, flexDirection: 'row', gap: 6, alignItems: 'center' },
  readyDot: { width: 6, height: 6, borderRadius: 3 },
  readyLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  sheetBackdrop: { ...StyleSheet.absoluteFill },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '88%', maxHeight: 800, borderTopLeftRadius: 30, borderTopRightRadius: 30, borderWidth: 1, overflow: 'hidden' },
  sheetHandle: { height: 24, justifyContent: 'center', alignItems: 'center' },
  handleBar: { width: 37, height: 4, borderRadius: 4, opacity: 0.55 },
  sheetTopbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 17, height: 47 },
  sheetKicker: { fontSize: 9, letterSpacing: 1.35, fontWeight: '700' },
  sheetActions: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  sheetIconButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  sheetScroll: { flex: 1 },
  sheetContent: { paddingHorizontal: 22, paddingTop: 12, paddingBottom: 24 },
  senderDetail: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 20 },
  avatarLarge: { width: 43, height: 43, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  senderDetailCopy: { flex: 1, gap: 4 },
  senderDetailName: { fontSize: 13, fontWeight: '700' },
  detailSubject: { fontSize: 24, lineHeight: 30, letterSpacing: -0.6, fontWeight: '700' },
  toLine: { marginTop: 9, fontSize: 10 },
  otpCard: { marginTop: 20, borderWidth: 1, borderRadius: 19, minHeight: 76, paddingHorizontal: 15, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  otpValue: { fontSize: 23, fontWeight: '700', letterSpacing: 3, marginTop: 4 },
  bodyCard: { borderRadius: 21, borderWidth: 1, padding: 17, marginTop: 20, minHeight: 120 },
  bodyText: { fontSize: 14, lineHeight: 23 },
  bodyLoading: { gap: 12, paddingTop: 5 },
  bodyError: { gap: 15 },
  savedNote: { fontSize: 10, textAlign: 'center', marginTop: 13 },
  toast: { position: 'absolute', alignSelf: 'center', borderWidth: 1, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: '90%' },
  toastText: { fontSize: 12, fontWeight: '600' },
});
