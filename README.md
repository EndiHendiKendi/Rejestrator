# Rejestrator — La Luna di Bastremoli

PWA do zarządzania rezerwacjami + powiadomienia push (check-in/out, śmieci, podatki, IMU, licznik wody).

## TL;DR — co właściwie robisz, a czego NIE musisz dotykać

- **Apka i jej "mózg" (cron, wysyłka powiadomień) = GitHub.** To jedyne miejsce,
  do którego będziesz wracać.
- **Vercel = tylko cichy magazyn danych** (2 malutkie pliki + baza KV). Ustawiasz
  go RAZ (sekcja "Deploy" niżej) i **nigdy więcej nie musisz tam wchodzić.**
  Żadnego konfigurowania crona na Vercelu — w ogóle go tam nie ma.
- PWA instalujesz i używasz **wyłącznie** z adresu `https://twoja-nazwa.github.io/...`
  (GitHub Pages). Nigdy z adresu `*.vercel.app` — to był dokładnie powód buga
  z 404 po kliknięciu powiadomienia (patrz "Rozwiązywanie problemów" niżej).

## Krok 1 — GitHub Pages (apka)

1. Repo na GitHubie → **Settings → Pages**.
2. Source: **Deploy from a branch** → branch `main`, folder `/ (root)` → **Save**.
3. Po ~1 minucie apka będzie pod `https://twoja-nazwa.github.io/Rejestrator/`
   (GitHub poda dokładny adres na tej samej stronie Settings → Pages,
   pod napisem "Your site is live at...").
4. To jest **jedyny** adres, z którego instalujesz PWA i włączasz powiadomienia.

## Krok 2 — Vercel (tylko magazyn danych, robisz to raz i zapominasz)

1. Importuj repo na vercel.com.
2. Dodaj **Vercel KV** (Storage → Create → KV) i połącz z projektem — zmienne
   `KV_*` ustawią się automatycznie.
3. Ustaw zmienne środowiskowe (Project → Settings → Environment Variables):
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` — wygeneruj raz: `npx web-push generate-vapid-keys`
   - `VAPID_EMAIL` — np. `mailto:twoj@email.com`
   - `CRON_SECRET` — losowy ciąg znaków (Vercel czasem ustawia go sam dla
     wbudowanego crona — sprawdź czy już istnieje, jeśli nie, dodaj własny)
4. Resztę (instalacja PWA, włączenie powiadomień) robisz z adresu GitHub Pages
   z Kroku 1 — apka sama, w tle, woła do tego adresu Vercel po dane przez
   pole "Adres serwera" przy pierwszym uruchomieniu. Adresu `*.vercel.app`
   nigdy nie otwierasz w przeglądarce.

## Powiadomienia push — jak to działa

- `api/cron.js` to jeden endpoint, który: synchronizuje iCal, sprawdza
  zaplanowane powiadomienia (check-in/out, rozliczenie) i sprawdza
  daty specjalne (licznik wody 25., podatek 15 maja, IMU 1 czerwca/grudnia,
  śmieci dzień przed o 18:00 czasu włoskiego — tylko w trybie wakacyjnym).
- **Vercel Hobby pozwala na własny cron co najwyżej raz dziennie** —
  `vercel.json` ma więc tylko zapasowy tick raz na dobę.
- Realne odpytywanie **co 15 minut, niezależnie od telefonu/apki**
  (tak jak WhatsApp/Gmail) robi **GitHub Actions**:
  `.github/workflows/cron.yml`.

## Krok 3 — GitHub Actions (jednorazowo, ~2 minuty)

To jedyne miejsce, gdzie wracasz, jeśli coś chcesz zmienić w przyszłości.

Repo → **Settings → Secrets and variables → Actions** → dodaj:
- `APP_URL` — `https://twoj-projekt.vercel.app` (bez `/` na końcu)
- `CRON_SECRET` — ta sama wartość co w zmiennych środowiskowych na Vercel

Jeśli repo jest publiczne, GitHub *mógłby* po 60 dniach bez żadnego commitu
wyłączyć harmonogram — workflow ma to już rozwiązane samodzielnie: raz dziennie
robi mały "keepalive" commit, więc nawet jeśli realne powiadomienia (np.
podatek czy IMU) zdarzają się raz w roku, harmonogram nigdy się nie wyłączy
i nie musisz o tym pamiętać. Jedyny wymagany krok z Twojej strony: w
**Settings → Actions → General → Workflow permissions** zaznacz
**"Read and write permissions"** — bez tego ten commit nie ma prawa się wykonać
(GitHub poprosi Cię o to przy pierwszym nieudanym uruchomieniu, zobaczysz to
w zakładce Actions).

## Ikony

- `icon-192.png` / `icon-512.png` — kolorowa ikona apki (manifest, ekran
  główny, duża ikona w treści powiadomienia).
- `badge.png` (96×96) — **monochromatyczna** sylwetka (biała na
  przezroczystym tle), używana jako `badge` w `showNotification`. Android
  **wymaga** przezroczystości dla małej ikony w pasku statusu — kolorowa,
  w pełni wypełniona ikona renderuje się tam jako biały kwadrat.

## Rozwiązywanie problemów

**Kliknięcie powiadomienia otwiera 404 / "There isn't a GitHub Pages site here".**
Najpierw sprawdź najprostszą przyczynę: czy GitHub Pages jest w ogóle włączone
dla tego repo (Krok 1 wyżej, Settings → Pages → musi tam być zielony napis
"Your site is live at..."). Jeśli go nie ma — to jest cała przyczyna, włącz
Pages i problem zniknie.

Jeśli Pages jest włączone, a 404 nadal się zdarza: Service Worker i
subskrypcja push są przypisane do *origin* (domeny), pod którą apka była
zainstalowana, gdy włączałeś powiadomienia. Jeśli kiedyś włączyłeś
powiadomienia testując apkę pod adresem `*.vercel.app` (a nie pod
`*.github.io`), telefon ma zarejestrowany Service Worker pod tamtą domeną —
nowy kod tego nie nadpisze, bo to inna domena. Trzeba to wyczyścić ręcznie raz:
1. Odinstaluj PWA z ekranu głównego (jeśli zainstalowana).
2. W Chrome: wejdź na **stary** adres → ikona kłódki/ⓘ przy adresie →
   **Ustawienia witryny** → **Wyczyść dane** (to usuwa stary Service Worker
   i subskrypcję).
3. Wejdź na **właściwy** adres GitHub Pages (`https://twoja-nazwa.github.io/...`),
   ponownie zainstaluj PWA i ponownie włącz powiadomienia.

**Powiadomienie nie przyszło o właściwej godzinie, ale "magicznie" pojawiło
się po otwarciu apki.** To był stary lokalny fallback w `index.html`, który
sprawdzał godzinę co minutę, ale tylko gdy apka była otwarta na ekranie —
usunięty. Teraz jedynym źródłem jest serwerowy `/api/cron` odpytywany przez
GitHub Actions (patrz wyżej) — działa nawet gdy telefon jest zablokowany.
