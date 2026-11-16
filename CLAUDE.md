# Thoughtful, Minimal, Efficient

Make software thoughtful, minimal and efficient. When they conflict, the earlier wins: accessibility beats a sparer look, and a sparer look beats saving the machine some work.

## Thoughtfulness

Care for the person: their abilities, their situation and their mistakes.

- **Kind.** Never nag or manipulate, and be honest about limits. *Would it feel fair if done to you?*
- **Private.** Collect nothing, ask for the fewest permissions, and encrypt what leaves the device. *What could someone learn from everything it stores or sends?*
- **Secure.** Make it safe by default: treat everything from outside as untrusted, keep secrets out of code and logs, and give each part only the access it needs. *What could someone do with it if they tried?*
- **Accessible.** Make it usable by anyone, whatever their sight, hands, language or device. Treat this as the baseline, not a feature. *Could someone with low vision, a screen reader or another language do this?*
- **Interoperable.** Use open standards, formats and protocols, follow the platform's conventions, and let data move in and out freely. Never lock people in. *Could the person take their data to another tool today?*
- **Open.** Publish readable, documented source, so anyone can check it, fix it or build on it. *Could a newcomer see how it works?*
- **Considered.** Think it through before building: picture the moment of use, and have the next step ready. *Is the next step already within reach?*
- **Uncomplicated.** Offer one obvious way to do each thing: let people act on the thing itself, prefer words to icons, give each signal one meaning, and quietly show what just happened. *Could someone do this without being shown?*
- **Aware of context.** Read the device, theme, language and connection rather than ask, and choose good defaults for the rest. *Is it asking for something it could know?*
- **Forgiving.** Make mistakes cheap to undo, and confirm only what can't be undone. *How quickly can an accident be put right?*
- **Resilient.** Never lose what the person entered, and keep working when things go wrong: no signal, a server down, an interrupted update. Recover without help, and say what happened in plain words. *What happens to their work if the network or the app fails halfway?*

## Minimalism

Keep to few things, said briefly and kept quiet.

- **Unobtrusive.** Stay calm: nothing urgent, nothing asking for attention. Do the job, then step back. *Does it ask for attention nobody offered?*
- **Concise.** Use plain words, and only as many words and controls as the job needs, in the interface, the docs and the code alike. *What can go without losing meaning?*
- **Small.** Keep code, dependencies and download small, and make every addition earn its weight. *Could it be smaller and still work?*
- **Focused.** Do few things, completely, and say no to the rest. Suggest additions; never slip them in. *Is this part of what it's for?*
- **Not brutalist.** Keep the structure and warmth that make content clear: grouping, hierarchy, colour with meaning, a good typeface. Drop decoration. *Does each element carry meaning or structure?*

## Efficiency

Get the most from the least: money, hardware and the person's effort.

- **Low cost.** Keep it cheap to run and to maintain: few dependencies, and no code kept only for the past. *What will it cost in a year?*
- **Lasting.** Build it to work for years with little upkeep, depending on nothing likely to disappear. *Will it still work in five years, untouched?*
- **Economical.** Make one mechanism do several jobs rather than build several mechanisms. *Could something that already exists do this?*
- **Light on hardware.** Run, fetch and stay awake only for a reason the person can see. *What does it do when nobody is looking?*
- **Light on the person.** Keep steps to a minimum, and make no one wait. *How many steps, and how much waiting, from wanting to done?*

## How to work

1. **Decide on paper first.** Agree a short design note before building anything that changes how data is stored or shared.
2. **Judge on real screens,** with two or three distinct directions side by side, and let whoever owns the decision make it.
3. **Test beside the real thing.** Switch only once the new version has proved itself.
4. **Test automatically what people rely on,** on every change: their data, syncing and the main paths.
5. **Start clean while users are few,** carrying their data across by export and import rather than migrations.
6. **Prune after every batch of changes:** dead code, needless defences, unused settings, and say what went. Software accretes, especially when generated.
7. **Answer every question in this guide,** before building and before shipping.
