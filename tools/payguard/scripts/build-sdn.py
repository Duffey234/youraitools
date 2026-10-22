#!/usr/bin/env python3
"""Build src/data/sdn.js from the official US Treasury OFAC SDN list (no third-party mirrors).

  python3 scripts/build-sdn.py [--sdn SDN.XML] [--advanced SDN_ADVANCED.XML] [--out src/data/sdn.js]

Without file arguments both files are downloaded from sanctionslistservice.ofac.treas.gov.
- SDN.XML (classic): entity name, type, programs and every 'Digital Currency Address - XXX' id.
- SDN_ADVANCED.XML: the SanctionsEntry EntryEvent date per profile (= the date the entry was added to the SDN list).
Lookup keys: 0x-hex (EVM) and bech32 / cashaddr addresses are lower-cased (case-insensitive formats); everything
else (base58: BTC legacy, TRX, SOL, LTC, XMR ...) is kept exact. Output is deterministic (sorted) so an unchanged
list produces an unchanged file."""
import argparse, json, re, sys, urllib.request, datetime, os
from lxml import etree

BASE = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/"
UA = "PayGuard-SDN-builder/0.1 (+https://payguard.agentgate.workers.dev)"

def fetch(name, dest):
    req = urllib.request.Request(BASE + name, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b: break
            f.write(b)
    return dest

def norm(addr):
    a = addr.strip()
    low = a.lower()
    if re.fullmatch(r"0x[0-9a-fA-F]{40}", a): return low
    if re.match(r"^(bc1|tb1|ltc1|bnb1|bitcoincash:|bchtest:)", low): return low.split(":", 1)[-1] if low.startswith(("bitcoincash:", "bchtest:")) else low
    if re.fullmatch(r"[qp][0-9a-z]{41}", low) and a in (low, a.upper()): return low  # bare cashaddr
    return a

def local(tag): return tag.rsplit('}', 1)[-1]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sdn"); ap.add_argument("--advanced"); ap.add_argument("--out", default="src/data/sdn.js")
    ap.add_argument("--json", help="also write the lookup as plain JSON")
    a = ap.parse_args()
    tmp = "/tmp/payguard-ofac"; os.makedirs(tmp, exist_ok=True)
    sdn = a.sdn or fetch("SDN.XML", f"{tmp}/SDN.XML")
    adv = a.advanced or fetch("SDN_ADVANCED.XML", f"{tmp}/SDN_ADVANCED.XML")

    entities, addresses, publish, record_count = {}, {}, None, None
    for _, el in etree.iterparse(sdn, events=("end",), huge_tree=True):
        t = local(el.tag)
        if t == "Publish_Date": publish = el.text
        elif t == "Record_Count": record_count = int(el.text)
        elif t == "sdnEntry":
            ids = []
            for idel in el.iter("{*}id"):
                ty = idel.findtext("{*}idType") or ""
                if ty.startswith("Digital Currency Address - "):
                    ids.append((ty.split(" - ", 1)[1].strip(), (idel.findtext("{*}idNumber") or "").strip()))
            if ids:
                uid = el.findtext("{*}uid")
                name = ", ".join(x for x in [el.findtext("{*}lastName"), el.findtext("{*}firstName")] if x)
                if el.findtext("{*}firstName"):
                    name = f"{el.findtext('{*}firstName')} {el.findtext('{*}lastName')}".strip()
                progs = [p.text for p in el.iter("{*}program") if p.text]
                entities[uid] = {"name": name, "type": el.findtext("{*}sdnType"), "programs": progs, "list_date": None}
                for cur, addr in ids:
                    if not addr: continue
                    k = norm(addr)
                    lst = addresses.setdefault(k, [])
                    if [uid, cur] not in lst: lst.append([uid, cur])
            el.clear()

    # Entry dates from the advanced file (ProfileID == classic uid)
    issue = None
    want = set(entities)
    for _, el in etree.iterparse(adv, events=("end",), tag=("{*}SanctionsEntry", "{*}DateOfIssue"), huge_tree=True):
        if local(el.tag) == "DateOfIssue" and issue is None:
            y, m, d = (el.findtext("{*}Year"), el.findtext("{*}Month"), el.findtext("{*}Day"))
            issue = f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
        elif local(el.tag) == "SanctionsEntry":
            pid = el.get("ProfileID")
            if pid in want:
                dates = []
                for ev in el.iter("{*}EntryEvent"):
                    dt = ev.find("{*}Date")
                    if dt is not None and dt.findtext("{*}Year"):
                        dates.append(f"{int(dt.findtext('{*}Year')):04d}-{int(dt.findtext('{*}Month') or 1):02d}-{int(dt.findtext('{*}Day') or 1):02d}")
                if dates: entities[pid]["list_date"] = min(dates)
            el.clear()

    m, d, y = publish.split("/")
    pub_iso = f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
    by_cur = {}
    for lst in addresses.values():
        for _, cur in lst: by_cur[cur] = by_cur.get(cur, 0) + 1
    data = {
        "source": "US Treasury OFAC Specially Designated Nationals (SDN) list",
        "source_url": BASE + "SDN.XML",
        "publish_date": pub_iso, "advanced_date_of_issue": issue, "sdn_record_count": record_count,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "address_count": len(addresses), "address_ids": sum(len(v) for v in addresses.values()), "entity_count": len(entities),
        "by_currency": dict(sorted(by_cur.items())),
        "entities": dict(sorted(entities.items(), key=lambda kv: int(kv[0]))),
        "addresses": dict(sorted(addresses.items())),
    }
    body = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    with open(a.out, "w") as f:
        f.write("// GENERATED by scripts/build-sdn.py from the official OFAC SDN list. Do not edit by hand.\n")
        f.write(f"export const SDN = {body};\n")
    if a.json:
        with open(a.json, "w") as f: f.write(body)
    missing = sum(1 for e in entities.values() if not e["list_date"])
    print(json.dumps({"publish_date": pub_iso, "advanced_issue": issue, "addresses": len(addresses), "entities": len(entities), "missing_list_date": missing, "by_currency": by_cur, "bytes": len(body)}))

if __name__ == "__main__": main()
