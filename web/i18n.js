// The words on screen, in English or French, following the phone's language.
//
// English is written in the code as it is; t() looks it up here for French, with {name}
// for the parts that change. Anything missing stays in English.

const preferred = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"];
export const lang = preferred.map(l => String(l).slice(0, 2).toLowerCase()).find(l => l === "en" || l === "fr") || "en";

const nb = " "; // French puts a narrow no-break space before : and inside « »
const FR = {
  // The page
  "Shopping list": "Liste de courses",
  "Renamed the list to {x}": "Liste renommée en {x}",
  "renaming the list {x}": "renommer la liste {x}",
  "Add a section": "Ajouter une section",
  "{n} ticked": ["{n} coché", "{n} cochés"],
  "Add someone to this list": "Ajouter quelqu’un à cette liste",
  "Settings": "Paramètres",
  "Open the link from a phone that already has the list.": "Ouvrez le lien depuis un téléphone qui a déjà la liste.",
  "Or start a new list with your server's setup code": "Ou commencez une nouvelle liste avec le code d’installation de votre serveur",
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
  "Keep it on this phone": "La garder sur ce téléphone",
  "Export the list": "Exporter la liste",
  "About": "À propos",
  "Version": "Version",
  "Server": "Serveur",
  "Your list is encrypted on your phones, with a key that never leaves them. The server keeps it without being able to read it: it can't see your items, your sections or anything you type. It can see when changes are made, roughly how big they are, and the internet address they come from.":
    "Votre liste est chiffrée sur vos téléphones, avec une clé qui ne les quitte jamais. Le serveur la conserve sans pouvoir la lire" + nb + ": il ne voit ni vos articles, ni vos sections, ni rien de ce que vous tapez. Il voit quand des modifications sont faites, leur taille approximative et l’adresse internet d’où elles viennent.",
  "Source code": "Code source",
  ", under the MIT licence.": ", sous licence MIT.",
  "They scan this code with their phone, or open the link you send them.": "La personne scanne ce code avec son téléphone, ou ouvre le lien que vous lui envoyez.",
  "Share link": "Partager le lien",
  "Copy link": "Copier le lien",
  "Copied": "Copié",
  "Couldn't copy": "Copie impossible",
  "This link is the key to your list: anyone who has it can open it. Keep a copy in your password manager to recover the list if you lose your phones.":
    "Ce lien est la clé de votre liste" + nb + ": quiconque l’a peut l’ouvrir. Gardez-en une copie dans votre gestionnaire de mots de passe pour retrouver la liste si vous perdez vos téléphones.",

  // Sections
  "Essentials": "Essentiels",
  "Look out for": "À l’occasion",
  "Long term": "À long terme",
  "Untitled": "Sans titre",
  "this section": "cette section",
  "Add item": "Ajouter un article",
  "Add item to {x}": "Ajouter un article à {x}",
  "{x}, rename": "{x}, renommer",
  "Bought before": "Déjà achetés",
  "Colour of {x}": "Couleur de {x}",
  "White": "Blanc", "Ink": "Encre", "Green": "Vert", "Teal": "Bleu canard", "Blue": "Bleu", "Indigo": "Indigo",
  "Plum": "Prune", "Rose": "Rose", "Amber": "Ambre", "Olive": "Olive",
  "{x} is now {y}": "{x} est maintenant {y}",
  "Delete section {x}": "Supprimer la section {x}",
  "Added section {x}": "Section ajoutée" + nb + ": {x}",
  "Renamed section to {x}": "Section renommée en {x}",
  "Deleted section {x}": "Section supprimée" + nb + ": {x}",
  "Section moved: {x}": "Section déplacée" + nb + ": {x}",
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

  // Undo and redo: what each step did
  "checking {x}": "cocher {x}",
  "unchecking {x}": "décocher {x}",
  "putting back {x}": "remettre {x}",
  "changing {x}": "modifier {x}",
  "adding {x}": "ajouter {x}",
  "deleting {x}": "supprimer {x}",
  "moving {x}": "déplacer {x}",
  "renaming {x}": "renommer {x}",
  "splitting {x}": "couper {x}",
  "joining {x} and {y}": "réunir {x} et {y}",
  "removing {x} from suggestions": "retirer {x} des suggestions",
  "adding section {x}": "ajouter la section {x}",
  "renaming section {x}": "renommer la section {x}",
  "deleting section {x}": "supprimer la section {x}",
  "moving section {x}": "déplacer la section {x}",
  "changing the colour of {x}": "changer la couleur de {x}",
  "Undo {x}": "Annuler" + nb + ": {x}",
  "Redo {x}": "Rétablir" + nb + ": {x}",
  "Undid {x}": "Annulé" + nb + ": {x}",
  "Redid {x}": "Rétabli" + nb + ": {x}",
  "Nothing to undo: the other phone already changed it": "Rien à annuler" + nb + ": l’autre téléphone l’a déjà modifié",
  "Nothing to redo: the other phone already changed it": "Rien à rétablir" + nb + ": l’autre téléphone l’a déjà modifié",

  // Connection
  "List full": "Liste pleine",
  "Offline": "Hors ligne",
  "Can't reach the server": "Serveur injoignable",
  "Back online": "De retour en ligne",
  "{n} changes are saved on this phone": ["{n} modification est enregistrée sur ce téléphone", "{n} modifications sont enregistrées sur ce téléphone"],
  "Changes you make are saved on this phone": "Vos modifications sont enregistrées sur ce téléphone",
  "The server has no room left for this list. {kept}.": "Le serveur n’a plus de place pour cette liste. {kept}.",
  "No connection. {kept}, to be sent when you're back online.": "Pas de connexion. {kept}, à envoyer dès votre retour en ligne.",
  "The server isn't answering. {kept}, to be sent as soon as it answers.": "Le serveur ne répond pas. {kept}, à envoyer dès qu’il répondra.",

  // Settings
  "Kept on this phone: the browser won't clear the list to free up space.": "Gardée sur ce téléphone" + nb + ": le navigateur n’effacera pas la liste pour libérer de la place.",
  "If this phone runs low on space, the browser may clear the list; the link from {link} brings it back.":
    "Si ce téléphone manque de place, le navigateur peut effacer la liste" + nb + "; le lien de {link} permet de la retrouver.",
  "On this phone": "Sur ce téléphone",
  "{size}: {toGet} to get, {done}": "{size}" + nb + ": {toGet} à acheter, {done}",
  "{n} items": ["{n} article", "{n} articles"],
  "{n} bought before": ["{n} déjà acheté", "{n} déjà achetés"],
  "{n} bytes": "{n} octets",
  "{n} KB": "{n} Ko",
  "{n} MB": "{n} Mo",

  // Switching lists
  "Switch to another list?": "Passer à une autre liste" + nb + "?",
  "This phone will leave {x} and open the list from the link.": "Ce téléphone quittera {x} et ouvrira la liste du lien.",
  "{n} changes made here haven't been sent yet, and would be lost.": ["{n} modification faite ici n’a pas encore été envoyée et serait perdue.", "{n} modifications faites ici n’ont pas encore été envoyées et seraient perdues."],
  "Cancel": "Annuler",
  "Switch": "Changer",

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
// Quotes around a name.
export const q = s => (lang === "fr" ? "«" + nb + s + nb + "»" : "“" + s + "”");

// The page's own text and labels, translated once at start.
export function translatePage(root = document.body) {
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
