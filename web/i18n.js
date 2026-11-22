// The words on screen, in English or French, following the phone's language.
//
// English is written in the code as it is; t() looks it up here for French, with {name}
// for the parts that change. Anything missing stays in English.

const preferred = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"];
export const lang = preferred.map(l => String(l).slice(0, 2).toLowerCase()).find(l => l === "en" || l === "fr") || "en";

const nb = " "; // French puts a narrow no-break space before : and inside « »
const FR = {
  // The page
  "Untitled list": "Liste sans nom",
  "Name this list": "Nommer cette liste",
  "Renamed the list to {x}": "Liste renommée en {x}",
  "renaming the list {x}": "renommer la liste {x}",
  "Add a section": "Ajouter une section",
  "{n} ticked": ["{n} coché", "{n} cochés"],
  "Me": "Moi",

  // A list's settings
  "List settings": "Paramètres de la liste",
  "Name and colour": "Nom et couleur",
  "Name": "Nom",
  "Ticked items stay in view": "Les articles cochés restent visibles",
  "A day": "Un jour",
  "A week": "Une semaine",
  "A month": "Un mois",
  "Always": "Toujours",
  "After that, they're still suggested as you type.": "Ensuite, ils restent proposés pendant la saisie.",
  "People": "Personnes",
  "Add someone": "Ajouter quelqu’un",
  "A code to scan, or a link to send": "Un code à scanner, ou un lien à envoyer",
  "{x} on this phone.": "{x} sur ce téléphone.",
  "A Markdown file": "Un fichier Markdown",
  "From this phone, or for everyone": "De ce téléphone, ou pour tout le monde",
  "From this phone": "De ce téléphone",
  "at {x}": "à {x}",
  "Settings": "Paramètres",
  "Lists": "Listes",
  "Start": "Commencer",
  "Undo": "Annuler",
  "Redo": "Rétablir",
  "Close": "Fermer",
  "Clear": "Effacer",
  "Appearance": "Apparence",
  "Same as phone": "Comme le téléphone",
  "Light": "Clair",
  "Dark": "Sombre",
  "Compact layout": "Affichage compact",
  "Data": "Données",
  "Keep lists on this phone": "Garder les listes sur ce téléphone",
  "Export the list": "Exporter la liste",
  "Delete the list": "Supprimer la liste",
  "Export all lists": "Exporter toutes les listes",
  "Set up another phone": "Configurer un autre téléphone",
  "You": "Vous",
  "Your name, shown to the people you share lists with": "Votre nom, que voient les personnes avec qui vous partagez des listes",
  "About": "À propos",
  "Version": "Version",
  "Server": "Serveur",
  "Your lists are encrypted on your phones, with keys that never leave them. The server stores them but can't read them: it never sees your items, your sections, your name or anything you type. It does see when changes are made, roughly how big they are, and the internet address they come from.":
    "Vos listes sont chiffrées sur vos téléphones, avec des clés qui ne les quittent jamais. Le serveur les conserve sans pouvoir les lire" + nb + ": il ne voit jamais vos articles, vos sections, votre nom, ni rien de ce que vous tapez. Il voit en revanche quand des modifications sont faites, leur taille approximative et l’adresse internet d’où elles viennent.",
  "Source code": "Code source",
  ", under the MIT licence.": ", sous licence MIT.",
  "They scan this code with their phone, or open the link you send them.": "La personne scanne ce code avec son téléphone, ou ouvre le lien que vous lui envoyez.",
  "Share link": "Partager le lien",
  "Copy link": "Copier le lien",
  "Copied": "Copié",
  "Couldn't copy": "Copie impossible",
  "This link is the key to your list: anyone who has it can open it. Keep a copy in your password manager to recover the list if you lose your phones.":
    "Ce lien est la clé de votre liste" + nb + ": quiconque l’a peut l’ouvrir. Gardez-en une copie dans votre gestionnaire de mots de passe pour retrouver la liste si vous perdez vos téléphones.",
  "Scan this code with the other phone to give it every list on this one.": "Scannez ce code avec l’autre téléphone pour lui donner toutes les listes de celui-ci.",
  "This link holds the keys to all your lists: anyone who has it can open them. Keep it to yourself.":
    "Ce lien contient les clés de toutes vos listes" + nb + ": quiconque l’a peut les ouvrir. Gardez-le pour vous.",

  // The people on a list, and taking it away from them
  "you": "vous",
  "{n} phones without a name": ["{n} téléphone sans nom", "{n} téléphones sans nom"],
  "On this list: {x}.": "Sur cette liste" + nb + ": {x}.",
  "Only you, so far.": "Personne d’autre pour l’instant.",
  "Remove someone": "Retirer quelqu’un",
  "Delete for everyone": "Supprimer pour tout le monde",
  "Remove someone from {x}?": "Retirer quelqu’un de {x}" + nb + "?",
  "The list moves to a new key. Every other phone loses it, though each keeps what it had. Then send the new link to those who should keep it.":
    "La liste passe à une nouvelle clé. Les autres téléphones la perdent, mais chacun garde ce qu’il avait. Envoyez ensuite le nouveau lien aux personnes qui doivent la garder.",
  "Give it a new key": "Lui donner une nouvelle clé",
  "No connection. Your lists show as this phone last saw them.": "Pas de connexion. Vos listes s’affichent telles que ce téléphone les a vues la dernière fois.",
  "{x} has a new key": "{x} a une nouvelle clé",
  "Delete {x} for everyone?": "Supprimer {x} pour tout le monde" + nb + "?",
  "It goes from the server, and from every phone that has it as soon as they open it. Neither Undo nor its link can bring it back.":
    "Elle disparaît du serveur, et de chaque téléphone qui l’a dès qu’il l’ouvre. Ni Annuler ni son lien ne pourront la faire revenir.",
  "Delete": "Supprimer",
  "Delete from this phone": "Supprimer de ce téléphone",
  "Deleted {x} for everyone": "{x} supprimée pour tout le monde",
  "Delete {x}?": "Supprimer {x}" + nb + "?",
  "The others keep it. On this phone, Undo brings it back until Panier closes; after that, its link does.":
    "Les autres la gardent. Sur ce téléphone, Annuler la fait revenir tant que Panier reste ouvert" + nb + "; ensuite, son lien.",
  "Undo brings it back until Panier closes; after that, only its link does, if you kept one.":
    "Annuler la fait revenir tant que Panier reste ouvert" + nb + "; ensuite, seul son lien le peut, si vous l’avez gardé.",
  "It's already closed. Undo brings back what's left of it until Panier closes; after that, it's gone.":
    "Elle est déjà fermée. Annuler fait revenir ce qu’il en reste tant que Panier reste ouvert" + nb + "; ensuite, elle est perdue.",
  "Deleted {x} from this phone": "{x} supprimée de ce téléphone",
  "This server can't make another list from this one.": "Ce serveur ne peut pas créer d’autre liste à partir de celle-ci.",
  "someone else": "quelqu’un d’autre",
  "with {x}": "avec {x}",
  "{n} others": ["{n} autre", "{n} autres"],
  "{n} other phones": ["{n} autre téléphone", "{n} autres téléphones"],

  // The lists page
  "New list": "Nouvelle liste",
  "{x} moved earlier": "{x} avance",
  "{x} moved later": "{x} recule",
  "{n} to tick": ["{n} à cocher", "{n} à cocher"],
  "Nothing to tick": "Rien à cocher",
  "Closed": "Fermée",
  "Update Panier to open it": "Mettez Panier à jour pour l’ouvrir",
  "Open the link from a phone that already has a list, or start one with your server's setup code.":
    "Ouvrez le lien depuis un téléphone qui a déjà une liste, ou commencez-en une avec le code d’installation de votre serveur.",
  "Your server's setup code, to start the first list": "Le code d’installation de votre serveur, pour commencer la première liste",
  "Your server's setup code": "Le code d’installation de votre serveur",
  "This server asks for its setup code to make a list.": "Ce serveur demande son code d’installation pour créer une liste.",
  "There's no list to bring in from {x}.": "Aucune liste à importer depuis {x}.",
  "Brought in {x}": "Importé" + nb + ": {x}",
  "Bring in from Google Keep": "Importer depuis Google Keep",
  "Bring in": "Importer",
  "Bring in from a file": "Importer depuis un fichier",
  "Archived": "Archivée",
  "{n} lists": ["{n} liste", "{n} listes"],

  // Sections
  "Untitled section": "Section sans nom",
  "this section": "cette section",
  "Add item": "Ajouter un article",
  "Add item to {x}": "Ajouter un article à {x}",
  "{x}, rename": "{x}, renommer",
  "Ticked before": "Déjà cochés",
  "Colour of {x}": "Couleur de {x}",
  "White": "Blanc", "Ink": "Encre", "Green": "Vert", "Teal": "Bleu canard", "Blue": "Bleu", "Indigo": "Indigo",
  "Plum": "Prune", "Rose": "Rose", "Amber": "Ambre", "Olive": "Olive",
  "{x} is now {y}": "{x} est maintenant {y}",
  "Delete section {x}": "Supprimer la section {x}",
  "Added section {x}": "Section ajoutée" + nb + ": {x}",
  "Renamed section to {x}": "Section renommée en {x}",
  "Deleted section {x}": "Section supprimée" + nb + ": {x}",
  "Moved section {x}": "Section déplacée" + nb + ": {x}",
  "{x} moved up": "{x} remonte",
  "{x} moved down": "{x} descend",

  // Items
  "Edit {x}": "Modifier {x}",
  "Delete {x}": "Supprimer {x}",
  "{x} ticked": "{x} coché",
  "{x} back on the list": "{x} est de retour sur la liste",
  "{x} is already on the list": "{x} est déjà sur la liste",
  "{x} is already on the list, now {y}": "{x} est déjà sur la liste, désormais {y}",
  "Added {x}": "Ajouté" + nb + ": {x}",
  "Deleted {x}": "Supprimé" + nb + ": {x}",
  "Renamed to {x}": "Renommé en {x}",
  "{x} moved to {y}": "{x} déplacé dans {y}",
  "Split into {x} and {y}": "Coupé en {x} et {y}",
  "Joined into {x}": "Réuni en {x}",
  "Remove {x} from suggestions": "Retirer {x} des suggestions",
  "Removed {x} from suggestions": "{x} retiré des suggestions",
  "Added {n} items": ["{n} article ajouté", "{n} articles ajoutés"],
  "{n} already on the list": ["{n} déjà sur la liste", "{n} déjà sur la liste"],

  // Undo and redo: what each step did
  "ticking {x}": "cocher {x}",
  "unticking {x}": "décocher {x}",
  "putting back {x}": "remettre {x}",
  "changing {x}": "modifier {x}",
  "adding {x}": "ajouter {x}",
  "deleting {x}": "supprimer {x}",
  "moving {x}": "déplacer {x}",
  "renaming {x}": "renommer {x}",
  "splitting {x}": "couper {x}",
  "joining {x} and {y}": "réunir {x} et {y}",
  "removing {x} from suggestions": "retirer {x} des suggestions",
  "adding {n} items": ["ajouter {n} article", "ajouter {n} articles"],
  "adding section {x}": "ajouter la section {x}",
  "renaming section {x}": "renommer la section {x}",
  "deleting section {x}": "supprimer la section {x}",
  "moving section {x}": "déplacer la section {x}",
  "changing the colour of {x}": "changer la couleur de {x}",
  "Undo {x}": "Annuler" + nb + ": {x}",
  "Redo {x}": "Rétablir" + nb + ": {x}",
  "Undid {x}": "Annulé" + nb + ": {x}",
  "Redid {x}": "Rétabli" + nb + ": {x}",
  "Nothing to undo: {x} already changed it": "Rien à annuler" + nb + ": {x} l’a déjà modifié",
  "Nothing to redo: {x} already changed it": "Rien à rétablir" + nb + ": {x} l’a déjà modifié",

  // Connection
  "List full": "Liste pleine",
  "Offline": "Hors ligne",
  "Can't reach the server": "Serveur injoignable",
  "Back online": "De retour en ligne",
  "Phone storage full": "Stockage du téléphone plein",
  "This phone has no room left to save your lists. Changes still reach the server. Settings shows what takes the room; deleting a list frees it.":
    "Ce téléphone n’a plus de place pour enregistrer vos listes. Les modifications arrivent quand même au serveur. Les Paramètres montrent ce qui prend la place" + nb + "; supprimer une liste en libère.",
  "This phone has no room left to save your lists, so changes made now are lost if the app closes before they're sent. Settings shows what takes the room; deleting a list frees it.":
    "Ce téléphone n’a plus de place pour enregistrer vos listes" + nb + ": les modifications faites maintenant sont perdues si l’application se ferme avant leur envoi. Les Paramètres montrent ce qui prend la place" + nb + "; supprimer une liste en libère.",
  "{n} changes are saved on this phone": ["{n} modification est enregistrée sur ce téléphone", "{n} modifications sont enregistrées sur ce téléphone"],
  "Changes you make are saved on this phone": "Vos modifications sont enregistrées sur ce téléphone",
  "The server has no room left for this list. {kept}.": "Le serveur n’a plus de place pour cette liste. {kept}.",
  "No connection. {kept}, to be sent when you're back online.": "Pas de connexion. {kept}, à envoyer dès votre retour en ligne.",
  "The server isn't answering. {kept}, to be sent as soon as it answers.": "Le serveur ne répond pas. {kept}, à envoyer dès qu’il répondra.",
  "List closed": "Liste fermée",
  "Someone closed this list, for everyone. If they gave it a new key, ask them for the new link. What's here stays on this phone until you delete it.":
    "Quelqu’un a fermé cette liste, pour tout le monde. Si elle a une nouvelle clé, demandez le nouveau lien. Ce qui est ici reste sur ce téléphone jusqu’à ce que vous la supprimiez.",
  "Update Panier": "Mettez Panier à jour",
  "This list was changed with a newer Panier, which updates itself: close the app and open it again. Nothing is sent from here meanwhile.":
    "Cette liste a été modifiée avec une version plus récente de Panier, qui se met à jour toute seule" + nb + ": fermez l’application et rouvrez-la. Rien n’est envoyé d’ici en attendant.",

  // Settings
  "{n}, {x} on this phone.": "{n}, {x} sur ce téléphone.",
  "The browser won't clear your lists to free up space.": "Le navigateur n’effacera pas vos listes pour libérer de la place.",
  "If this phone runs low on space, the browser may clear your lists; their links bring them back.":
    "Si ce téléphone manque de place, le navigateur peut effacer vos listes" + nb + "; leurs liens permettent de les retrouver.",
  "Asks the browser not to clear them": "Demande au navigateur de ne pas les effacer",
  "One Markdown file, to keep or bring in elsewhere": "Un fichier Markdown, à garder ou à importer ailleurs",
  "Markdown, plain text or Google Keep": "Markdown, texte brut ou Google Keep",
  "One code gives it every list": "Un code lui donne toutes vos listes",
  "{n} items": ["{n} article", "{n} articles"],
  "{n} bytes": "{n} octets",
  "{n} KB": "{n} Ko",
  "{n} MB": "{n} Mo",

  "Cancel": "Annuler",

  // Starting
  "That setup code didn't work. Check it on the server and try again.": "Ce code d’installation n’a pas fonctionné. Vérifiez-le sur le serveur et réessayez.",
  "That link is incomplete. Ask for the link again from the phone that has the list.": "Ce lien est incomplet. Redemandez le lien au téléphone qui a la liste.",
  "Couldn't reach the server. Check your connection and try again.": "Impossible de joindre le serveur. Vérifiez votre connexion et réessayez.",
};

export function t(s, vars) {
  const fr = lang === "fr" && FR[s];
  const out = typeof fr === "string" ? fr : s;
  return vars ? out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : out;
}
// A count, one or many: English says "1 item", French counts 0 as one too. French
// entries for these hold both forms.
export function plural(n, one, many) {
  const fr = lang === "fr" && FR[many];
  const form = Array.isArray(fr) ? fr[n <= 1 ? 0 : 1] : n === 1 ? one : many;
  return form.replace("{n}", n);
}
// When something happened: "at 12:45" today, then "yesterday", the day of the week for
// the rest of the week, then the date, "12 Nov", with the year if it isn't this one. The
// clock is the phone's own, 12 or 24 hours.
const clock = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const weekday = new Intl.DateTimeFormat(lang, { weekday: "long" });
const yesterday = new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(-1, "day");
const date = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short" });
const dated = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", year: "numeric" });
const dayOf = ms => { const d = new Date(ms); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5; };
export function when(ms) {
  const back = dayOf(Date.now()) - dayOf(ms);
  if (back < 1) return t("at {x}", { x: clock.format(ms) });
  if (back === 1) return yesterday;
  if (back < 7) return weekday.format(ms);
  return (new Date(ms).getFullYear() === new Date().getFullYear() ? date : dated).format(ms);
}
// Quotes around a name.
export const q = s => (lang === "fr" ? "«" + nb + s + nb + "»" : "“" + s + "”");
// Names in a sentence, joined as the language joins them: "Alex and Sam", "Alex, Sam and you".
const joined = new Intl.ListFormat(lang, { type: "conjunction" });
export const and = names => joined.format(names);

// The page's own text and labels, translated once at start.
export function translatePage() {
  const root = document.body;
  document.documentElement.lang = lang;
  if (lang === "en") return;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const k = n.nodeValue.trim();
    if (typeof FR[k] === "string") n.nodeValue = n.nodeValue.replace(k, FR[k]);
  }
  for (const el of root.querySelectorAll("[placeholder], [aria-label], [title]")) {
    for (const a of ["placeholder", "aria-label", "title"]) {
      const v = el.getAttribute(a);
      if (v && typeof FR[v] === "string") el.setAttribute(a, FR[v]);
    }
  }
}
