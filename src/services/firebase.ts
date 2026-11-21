export {
  app,
  analytics,
  db,
  auth,
  firebaseConfig,
  ensureFirebaseAuthSession,
  ensureFirebaseAuthSessionWithStatus,
  getLastAuthErrorCode,
  getLastAuthErrorMessage,
  isFirestoreQuotaExceeded,
  markFirestoreQuotaExceeded,
  resetFirestoreQuotaAndEnableNetwork,
  testFirestoreServerConnectionOnBoot
} from '../firebaseConfig';
