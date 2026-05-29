type DocTokenMode = "doctitle" | "title";

export const CANONICAL_TEMPLATE_SOURCE = "canonical-common";

export type TemplateSection = {
  id: string;
  heading: string;
  level: number;
  aliases: string[];
  placeholder: string;
};

export type ReferenceProfile = {
  id: string;
  label: string;
  partnerAliases: string[];
  namingPattern: "docType_suse_partnerProduct";
  sectionAliases: Record<string, string[]>;
  sections: TemplateSection[];
  additionalSectionHeading: string;
  legalTail: string;
  variableSeed: "generic" | "wso2" | "clearml" | "hitachi";
};

export type ProfileResolution = {
  profile: ReferenceProfile;
  fallbackUsed: boolean;
};

export type ReferenceProfileContext = {
  baseName: string;
  docTypePrefix: string;
  docTokenMode: DocTokenMode;
  namingPattern: string;
  profileId: string;
  suseProductSlug: string;
  suseProductDisplay: string;
  partnerSlug: string;
  partnerDisplay: string;
  partnerProductSlug: string;
  partnerProductDisplay: string;
  pipelineName: string;
};

export type RenderedTemplateSection = {
  heading: string;
  normalizedHeading: string;
  lines: string[];
};

export type ReplacementCandidate = {
  literal: string;
  token: string;
};

const DEFAULT_NAMING_PATTERN = "docType_suse_partnerProduct";

const DEFAULT_LEGAL_TAIL = `// = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = =
// Do not modify below this break.
// = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = =

++++
<?pdfpagebreak?>
++++

:leveloffset: 0

== Legal notice
include::common_trd_legal_notice.adoc[]

++++
<?pdfpagebreak?>
++++

:leveloffset: 0
include::common_gfdl1.2_i.adoc[]

//end
`;

export const CANONICAL_TEMPLATE_DC = `# Comment out to deactivate draft mode when completed
DRAFT=yes
ROLE="trd"
#PROFROLE="trd"

## -------------------------------
## Doc Config File for DAPS
## Technical Reference Document
## -------------------------------

##
# Basics
##

# Main Document
MAIN="template_main"

# Format Type
ADOC_TYPE="article"
#ADOC_TYPE="book"

# Stylesheet Root
STYLEROOT="/usr/share/xml/docbook/stylesheet/trd"

# Turn on postprocessing
ADOC_POST="yes"

# Leverage SUSE Best Practices
#XSLTPARAM="--stringparam publishing.series=sbp"
DOCBOOK5_RNG_URI="http://docbook.org/xml/5.2/rng/docbookxi.rnc"

# Enable attributes
ADOC_ATTRIBUTES="--attribute env-daps=1"

# Treat warnings as non-fatal during AsciiDoc to DocBook conversion.
ADOC_FAILURE_LEVEL=ERROR

##
# Additional attributes
##
`;

export const CANONICAL_TEMPLATE_DOCINFO = `<!-- https://tdg.docbook.org/tdg/5.2/info -->

<dm:docmanager xmlns:dm="urn:x-suse:ns:docmanager">
    <dm:bugtracker>
        <dm:url>https://github.com/SUSE/technical-reference-documentation/issues/new</dm:url>
        <dm:product>{doctitle}</dm:product>
    </dm:bugtracker>
</dm:docmanager>

<meta name="series">Technical References</meta>
<meta name="type">Getting Started</meta>

<title>{doctitle}</title>
<subtitle>{docsubtitle}</subtitle>

<meta name="description">{description}</meta>
<meta name="social-desc">{description-social}</meta>

<meta name="task">
    <phrase>{metatask1}</phrase>
</meta>

<meta name="productname">
  <productname version="{comp1-version1}">{comp1-long}</productname>
  <productname version="{comp2-version1}">{comp2-long}</productname>
</meta>

<productname>{comp1} {comp1-version1}, {comp2} {comp2-version1}</productname>

<meta name="platform">{comp1-long} {comp1-version1}</meta>
<meta name="platform">{comp2-long} {comp2-version1}</meta>
<meta name="techpartner">{comp2-provider}</meta>

<authorgroup>
  <author>
    <personname>
      <firstname>{author1-firstname}</firstname>
      <surname>{author1-surname}</surname>
    </personname>
    <affiliation>
      <jobtitle>{author1-jobtitle}</jobtitle>
      <orgname>{author1-orgname}</orgname>
    </affiliation>
  </author>
</authorgroup>

<cover role="logos">
  <mediaobject>
    <imageobject role="fo">
      <imagedata fileref="suse.svg" width="5em"/>
    </imageobject>
    <imageobject role="html">
      <imagedata fileref="suse.svg" width="152px"/>
    </imageobject>
  </mediaobject>
</cover>

<revhistory xml:id="rh-art-{article-id}">
  <revision>
    <date>{rev1-date}</date>
    <revdescription>
      <para>{rev1-description}</para>
    </revdescription>
  </revision>
</revhistory>

<abstract role="executivesummary">
  <title>Summary</title>
  <para>{executive-summary}</para>
</abstract>

<abstract>
  <title>Disclaimer</title>
  <para>{disclaimer}</para>
</abstract>
`;

export const CANONICAL_TEMPLATE_VARS = `:article-id: unique-article-id

:rev1-date: YYYY-MM-DD
:rev1-description: Original version
:docdate: {rev1-date}

:comp1-provider: provider
:comp1: short name
:comp1-long: full product name
:comp1-brand: branded product name
:comp1-version1: first relevant version
:comp1-website: product website URL
:comp1-docs: product documentation URL

:comp2-provider: provider
:comp2: short name
:comp2-long: full product name
:comp2-brand: branded product name
:comp2-version1: first relevant version
:comp2-website: product website URL
:comp2-docs: product documentation URL

:doctitle: (<75 characters) Your Guide Title
:docsubtitle: (<75 characters) Your Guide Subtitle
:usecase: (<55 characters) use case
:description: (<150 characters) description
:description-social: (<55 characters) social media description
:executive-summary: (<300 characters) brief summary

:metatask1: task

:author1-firstname: first (given) name
:author1-surname: surname
:author1-jobtitle: job title
:author1-orgname: organization affiliation
`;

export const CANONICAL_COMMON_DOCINFO_VARS = `:disclaimer: Documents published as part of the series SUSE Technical Reference Documentation have been contributed voluntarily by SUSE employees and third parties. \\
They are meant to serve as examples of how particular actions can be performed. \\
They have been compiled with utmost attention to detail. However, this does not guarantee complete accuracy. \\
SUSE cannot verify that actions described in these documents do what is claimed or whether actions described have unintended consequences. \\
SUSE LLC, its affiliates, the authors, and the translators may not be held liable for possible errors or the consequences thereof.
`;

export const CANONICAL_COMMON_SBP_LEGAL_NOTICE = `Copyright (C) 2006-2026 SUSE LLC and contributors. All rights reserved.

Permission is granted to copy, distribute and/or modify this document under the terms of
the GNU Free Documentation License, Version 1.2 or (at your option) version 1.3; with the
Invariant Section being this copyright notice and license.
`;

export const CANONICAL_COMMON_TRD_LEGAL_NOTICE = `Copyright (C) 2006-2026 SUSE LLC and contributors. All rights reserved.

Permission is granted to copy, distribute and/or modify this document under the terms of
the GNU Free Documentation License, Version 1.2 or (at your option) version 1.3; with the
Invariant Section being this copyright notice and license.

{disclaimer}
`;

export const CANONICAL_COMMON_GFDL = `== GNU Free Documentation License
:imagesdir: ./images

This document is distributed under the GNU Free Documentation License, Version 1.2
or (at your option) version 1.3.
For the full license text, visit https://www.gnu.org/licenses/fdl-1.2.txt
`;

export const CANONICAL_SUSE_SVG = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg version="1.1" x="0" y="0" width="210.59975" height="38.090038" viewBox="0 0 210.59975 38.090038" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(-30.000256,-28.698704)">
    <path d="m 238.462,55.726 h -13.555 c -1.045,0 -1.896,-0.85 -1.896,-1.896 v -6.848 h 13.084 c 1.124,0 2.036,-0.911 2.036,-2.036 0,-1.125 -0.912,-2.037 -2.036,-2.037 H 223.011 V 36.17 c 0,-1.046 0.851,-1.897 1.896,-1.897 h 13.555 c 1.18,0 2.138,-0.955 2.138,-2.136 0,-1.18 -0.958,-2.137 -2.138,-2.137 h -13.555 c -3.4,0 -6.169,2.767 -6.169,6.17 v 17.66 c 0,3.402 2.769,6.169 6.169,6.169 h 13.555 c 1.18,0 2.138,-0.955 2.138,-2.135 0,-1.181 -0.958,-2.138 -2.138,-2.138" fill="#0c322c"/>
    <path d="m 101.408,42.16 c -0.405,0.269 -0.947,0.269 -1.353,0 -0.664,-0.441 -0.728,-1.363 -0.192,-1.896 0.476,-0.493 1.261,-0.493 1.737,-0.001 0.535,0.534 0.47,1.456 -0.192,1.897" fill="#30ba78"/>
  </g>
</svg>
`;

const GENERIC_SECTIONS: TemplateSection[] = [
  {
    id: "introduction",
    heading: "Introduction",
    level: 2,
    aliases: ["introduction", "overview"],
    placeholder:
      "Provide a concise introduction to the solution, scope, and value proposition.",
  },
  {
    id: "scope",
    heading: "Scope",
    level: 3,
    aliases: ["scope", "in scope", "out of scope"],
    placeholder: "Describe what is covered and not covered by this document.",
  },
  {
    id: "audience",
    heading: "Audience",
    level: 3,
    aliases: ["audience", "target audience", "intended audience"],
    placeholder:
      "Describe who should read this guide and any prerequisites for readers.",
  },
  {
    id: "business_aspect",
    heading: "Business aspect",
    level: 2,
    aliases: ["business aspect", "business context"],
    placeholder: "Summarize the business context and primary goals.",
  },
  {
    id: "architectural_overview",
    heading: "Architectural overview",
    level: 2,
    aliases: ["architectural overview", "architecture", "solution architecture"],
    placeholder: "Describe the high-level architecture and major design decisions.",
  },
  {
    id: "solution_components",
    heading: "Solution component overview",
    level: 2,
    aliases: ["solution component overview", "component overview", "components"],
    placeholder: "Summarize major software and infrastructure components.",
  },
  {
    id: "software_components",
    heading: "Software components",
    level: 2,
    aliases: ["software components", "software bill of materials", "software bom"],
    placeholder: "List software components, versions, and compatibility notes.",
  },
  {
    id: "hardware_components",
    heading: "Hardware components",
    level: 2,
    aliases: ["hardware components", "hardware bill of materials", "hardware bom"],
    placeholder: "List infrastructure requirements and tested hardware assumptions.",
  },
  {
    id: "deployment_prereqs",
    heading: "Deployment prerequisites and requirements",
    level: 2,
    aliases: ["prerequisites", "deployment prerequisites", "requirements"],
    placeholder:
      "Describe environment prerequisites, access requirements, and dependencies.",
  },
  {
    id: "deployment",
    heading: "Deployment",
    level: 2,
    aliases: ["deployment", "installation", "implementation"],
    placeholder: "Provide an ordered deployment flow with key validation checkpoints.",
  },
  {
    id: "validation",
    heading: "Validation",
    level: 2,
    aliases: ["validation", "verification", "testing"],
    placeholder: "Describe how to validate that the solution is functioning correctly.",
  },
  {
    id: "operational_considerations",
    heading: "Operational considerations",
    level: 2,
    aliases: ["operational considerations", "operations", "day 2 operations"],
    placeholder:
      "Document monitoring, observability, upgrades, and failure handling considerations.",
  },
  {
    id: "summary",
    heading: "Summary",
    level: 2,
    aliases: ["summary", "conclusion"],
    placeholder: "Summarize outcomes, key tradeoffs, and recommended next steps.",
  },
  {
    id: "faq",
    heading: "Frequently Asked Questions (FAQ)",
    level: 2,
    aliases: ["frequently asked questions", "faq", "questions"],
    placeholder: "Capture common business and technical questions with clear answers.",
  },
];

const PROFILE_CATALOG: ReferenceProfile[] = [
  {
    id: "generic",
    label: "Generic SUSE TRD",
    partnerAliases: [],
    namingPattern: "docType_suse_partnerProduct",
    sectionAliases: {},
    sections: GENERIC_SECTIONS,
    additionalSectionHeading: "Additional extracted content",
    legalTail: DEFAULT_LEGAL_TAIL,
    variableSeed: "generic",
  },
  {
    id: "wso2",
    label: "WSO2 Reference Profile",
    partnerAliases: ["wso2", "openchoreo"],
    namingPattern: "docType_suse_partnerProduct",
    sectionAliases: {
      introduction: ["introduction", "overview"],
      scope: ["scope"],
      audience: ["audience"],
      business_aspect: ["business aspect", "business problem", "business value"],
      architectural_overview: ["architectural overview", "architecture"],
      solution_components: ["solution component overview", "solution overview"],
      deployment_prereqs: ["deployment prerequisites and requirements", "prerequisites"],
      deployment: ["deployment", "installation"],
      validation: ["validation", "verification"],
      operational_considerations: ["operational considerations", "operations"],
      summary: ["summary", "conclusion"],
      faq: ["frequently asked questions", "faq"],
    },
    sections: GENERIC_SECTIONS,
    additionalSectionHeading: "Additional extracted content",
    legalTail: DEFAULT_LEGAL_TAIL,
    variableSeed: "wso2",
  },
  {
    id: "clearml",
    label: "ClearML Reference Profile",
    partnerAliases: ["clearml"],
    namingPattern: "docType_suse_partnerProduct",
    sectionAliases: {
      introduction: ["introduction", "overview"],
      scope: ["scope"],
      audience: ["audience"],
      business_aspect: ["business aspect", "business problem", "business value"],
      architectural_overview: ["architectural overview", "architecture"],
      solution_components: ["solution component overview", "solution overview"],
      deployment_prereqs: ["deployment prerequisites and requirements", "prerequisites"],
      deployment: ["deployment", "installation"],
      validation: ["validation", "verification"],
      operational_considerations: ["operational considerations", "operations"],
      summary: ["summary", "conclusion"],
      faq: ["frequently asked questions", "faq"],
    },
    sections: GENERIC_SECTIONS,
    additionalSectionHeading: "Additional extracted content",
    legalTail: DEFAULT_LEGAL_TAIL,
    variableSeed: "clearml",
  },
  {
    id: "hitachi",
    label: "Hitachi Getting Started Profile",
    partnerAliases: ["hitachi", "hitachi-storage", "virtualization"],
    namingPattern: "docType_suse_partnerProduct",
    sectionAliases: {
      introduction: ["introduction", "overview"],
      scope: ["scope"],
      audience: ["audience"],
      business_aspect: ["business aspect", "business problem", "business value"],
      architectural_overview: ["architectural overview", "architecture"],
      solution_components: ["solution component overview", "solution overview"],
      software_components: ["software components"],
      hardware_components: ["hardware components"],
      deployment_prereqs: ["deployment prerequisites and requirements", "prerequisites"],
      deployment: ["deployment", "installation"],
      validation: ["validation", "verification"],
      operational_considerations: ["operational considerations", "operations"],
      summary: ["summary", "conclusion"],
      faq: ["frequently asked questions", "faq"],
    },
    sections: GENERIC_SECTIONS,
    additionalSectionHeading: "Additional extracted content",
    legalTail: DEFAULT_LEGAL_TAIL,
    variableSeed: "hitachi",
  },
];

const toNormalizedKey = (value: string) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TOKEN_BOUNDARY_CLASS = "A-Za-z0-9_-";

const buildBoundaryAwarePattern = (literal: string) =>
  new RegExp(
    `(^|[^${TOKEN_BOUNDARY_CLASS}\\{])(${escapeRegExp(literal)})(?=$|[^${TOKEN_BOUNDARY_CLASS}\\}])`,
    "gi",
  );

const getHeadingPrefix = (level: number) => {
  if (level <= 1) return "=";
  if (level === 2) return "==";
  if (level === 3) return "===";
  if (level === 4) return "====";
  return "=====";
};

const uniqBy = <T>(items: T[], keyFn: (value: T) => string) => {
  const seen = new Set<string>();
  const output: T[] = [];
  items.forEach((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return;
    seen.add(key);
    output.push(item);
  });
  return output;
};

export const toDocTypePrefix = (documentTypeRaw?: string) => {
  const normalized = (documentTypeRaw || "").toLowerCase().trim();
  if (normalized === "reference-configuration" || normalized === "reference" || normalized === "rc") return "rc";
  if (normalized === "getting-started" || normalized === "gs") return "gs";
  const fallback = normalized.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return fallback || "rc";
};

export const resolveDocTokenMode = (docTypePrefix: string): DocTokenMode =>
  docTypePrefix === "gs" ? "title" : "doctitle";

export const getDocSubtitleForPrefix = (docTypePrefix: string) =>
  docTypePrefix === "gs" ? "Getting Started Guide" : "Reference Configuration";

export const getDocTypeMetaForPrefix = (docTypePrefix: string) =>
  docTypePrefix === "gs" ? "Getting Started" : "Reference Configuration";

const CANONICAL_TEMPLATE_MAIN_RC_BODY = `== Introduction

Add content here

=== Scope

Add content here

=== Audience

Add content here

=== Acknowledgments

Add content here

== Business considerations

Add content here

=== Challenge

Add content here

=== Value

Add content here

=== Use cases

Add content here

== Architecture

Add content here

== Design considerations

Add content here

== Deployment overview

Add content here

== Validation

Add content here

== Summary

Add content here

== Frequently Asked Questions (FAQs)

Add content here

== References

* Reference 1
* Reference 2

== Glossary

Term::
Definition
`;

const CANONICAL_TEMPLATE_MAIN_GS_BODY = `== Introduction

Your introduction and motivation for this guide

=== Scope

The scope for your guide

=== Audience

The intended audience for your guide

=== Acknowledgements

Any acknowledgments you would like to make

== Prerequisites

Add content here

== Procedure

Add content here

== Summary

Add content here
`;

export const buildCanonicalTemplateMain = (docTypePrefix: "rc" | "gs") => {
  const docSubtitle = docTypePrefix === "gs" ? "Getting Started Guide" : "Reference Configuration";
  const body = docTypePrefix === "gs" ? CANONICAL_TEMPLATE_MAIN_GS_BODY : CANONICAL_TEMPLATE_MAIN_RC_BODY;

  return `:docinfo:
include::./common_docinfo_vars.adoc[]
include::./template_vars[]
[#art-{article-id}]

// = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = =
// SUSE Technical Reference Documentation
// ${docSubtitle}
// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
//
// DOCUMENT ATTRIBUTES AND VARIABLES
//
// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
// 1. Define variables (document attributes) in the vars file.
// 2. Develop content and reference variables in the adoc file.
// 3. Update the docinfo.xml file as needed.
// 4. Update DC file (at a minimum, deactivate DRAFT mode)
//
// For further guidance, see
//   https://github.com/SUSE/technical-reference-documentation/blob/main/common/templates/start/README.md
// = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = =

= {doctitle}: {docsubtitle}

${body}

${DEFAULT_LEGAL_TAIL}`;
};

export const getCanonicalCommonAssets = () => ({
  "templates/template_DC": CANONICAL_TEMPLATE_DC,
  "templates/template_docinfo": CANONICAL_TEMPLATE_DOCINFO,
  "templates/template_vars": CANONICAL_TEMPLATE_VARS,
  "templates/template_main-rc": buildCanonicalTemplateMain("rc"),
  "templates/template_main-gs": buildCanonicalTemplateMain("gs"),
  "adoc/common_docinfo_vars.adoc": CANONICAL_COMMON_DOCINFO_VARS,
  "adoc/common_gfdl1.2_i.adoc": CANONICAL_COMMON_GFDL,
  "adoc/common_sbp_legal_notice.adoc": CANONICAL_COMMON_SBP_LEGAL_NOTICE,
  "adoc/common_trd_legal_notice.adoc": CANONICAL_COMMON_TRD_LEGAL_NOTICE,
  "images/src/svg/suse.svg": CANONICAL_SUSE_SVG,
});

export const resolveReferenceProfile = (partnerNameRaw?: string, profileIdRaw?: string): ProfileResolution => {
  const normalizedPartner = toNormalizedKey(partnerNameRaw || "");
  const normalizedProfileId = (profileIdRaw || "").toLowerCase().trim();

  if (normalizedProfileId) {
    const explicit = PROFILE_CATALOG.find((profile) => profile.id === normalizedProfileId);
    if (explicit) return { profile: explicit, fallbackUsed: explicit.id === "generic" };
  }

  const byPartner = PROFILE_CATALOG.find(
    (profile) =>
      profile.id !== "generic" &&
      profile.partnerAliases.some((alias) => {
        const normalizedAlias = toNormalizedKey(alias);
        return (
          normalizedPartner === normalizedAlias ||
          normalizedPartner.includes(normalizedAlias) ||
          normalizedAlias.includes(normalizedPartner)
        );
      }),
  );

  if (byPartner) return { profile: byPartner, fallbackUsed: false };
  const generic = PROFILE_CATALOG.find((profile) => profile.id === "generic")!;
  return { profile: generic, fallbackUsed: true };
};

export const buildBaseName = (args: {
  profile: ReferenceProfile;
  docTypePrefix: string;
  suseProductSlug: string;
  partnerProductSlug: string;
}) => {
  const pattern = args.profile.namingPattern || DEFAULT_NAMING_PATTERN;
  if (pattern === "docType_suse_partnerProduct") {
    return `${args.docTypePrefix}_${args.suseProductSlug}_${args.partnerProductSlug}`;
  }
  return `${args.docTypePrefix}_${args.suseProductSlug}_${args.partnerProductSlug}`;
};

const buildCommonVars = (context: ReferenceProfileContext, sourceDocumentTitle?: string) => {
  const today = new Date().toISOString().slice(0, 10);
  const docSubtitle = getDocSubtitleForPrefix(context.docTypePrefix);
  const description = `Validated ${docSubtitle.toLowerCase()} for {suse-product} and {partner-product}.`;
  const cleanSourceTitle = (sourceDocumentTitle || context.pipelineName || "").replace(/\s+/g, " ").trim();

  return {
    "article-id": context.baseName,
    docslug: context.baseName,
    doctitle: "{suse-product} and {partner-product}",
    docsubtitle: docSubtitle,
    title: "{suse-product} and {partner-product}",
    subtitle: docSubtitle,
    description,
    "description-social": description,
    "executive-summary":
      "This reference configuration describes an enterprise-ready architecture for {suse-product} and {partner-product}.",
    "rev1-date": today,
    "rev1-description": "Initial publication.",
    "rev2-date": today,
    "rev2-description": "Metadata synchronized.",
    docdate: today,
    docyear: today.slice(0, 4),
    disclaimer:
      "This document is for informational purposes only. SUSE and partner product behavior can change between releases.",
    suse: "SUSE",
    "suse-brand": "SUSE",
    "suse-product": context.suseProductDisplay,
    "suse-product-long": context.suseProductDisplay,
    "suse-product-provider": "SUSE",
    sai: context.suseProductDisplay,
    "sai-long": context.suseProductDisplay,
    "sai-brand": context.suseProductDisplay,
    "sai-provider": "SUSE",
    "sai-version": "",
    partner: context.partnerDisplay,
    "partner-brand": context.partnerDisplay,
    "partner-product": context.partnerProductDisplay,
    "partner-product-long": context.partnerProductDisplay,
    "partner-provider": context.partnerDisplay,
    "partner-website": "https://example.com",
    comp1: "{suse-product}",
    "comp1-long": "{suse-product-long}",
    "comp1-version1": "{sai-version}",
    "comp1-provider": "{suse-product-provider}",
    comp2: "{partner-product}",
    "comp2-long": "{partner-product-long}",
    "comp2-version1": "{cml-version}",
    "comp2-provider": "{partner-provider}",
    cml: "{partner-product}",
    "cml-brand": "{partner-product}",
    "cml-long": "{partner-product-long}",
    "cml-provider": "{partner-provider}",
    "cml-version": "",
    "cml-website": "{partner-website}",
    "pipeline-name": cleanSourceTitle || "{doctitle}",
    "metatask1": "reference architecture",
    "metatask2": "deployment",
    "metatask3": "validation",
    task1: "reference architecture",
    task2: "deployment",
    task3: "validation",
    "author1-firstname": "",
    "author1-surname": "",
    "author1-jobtitle": "",
    "author1-orgname": "",
    "author2-firstname": "",
    "author2-surname": "",
    "author2-jobtitle": "",
    "author2-orgname": "",
    "author3-firstname": "",
    "author3-surname": "",
    "author3-jobtitle": "",
    "author3-orgname": "",
    "contrib1-firstname": "",
    "contrib1-surname": "",
    "contrib1-jobtitle": "",
    "contrib1-orgname": "",
    "contrib2-firstname": "",
    "contrib2-surname": "",
    "contrib2-jobtitle": "",
    "contrib2-orgname": "",
    "contrib3-firstname": "",
    "contrib3-surname": "",
    "contrib3-jobtitle": "",
    "contrib3-orgname": "",
    "contrib4-firstname": "",
    "contrib4-surname": "",
    "contrib4-jobtitle": "",
    "contrib4-orgname": "",
    "sai-website": "https://www.suse.com/products/suse-ai/",
    "base-name": context.baseName,
    [context.docTypePrefix]: "1",
  } satisfies Record<string, string>;
};

const profileSeedVars = (profile: ReferenceProfile, context: ReferenceProfileContext) => {
  if (profile.variableSeed === "wso2") {
    return {
      srancher: "{suse-product}",
      "srancher-long": "{suse-product-long}",
      "srancher-brand": "{suse-product}",
      "srancher-provider": "SUSE",
      "srancher-version1": "",
      "srancher-website": "https://www.suse.com/products/suse-rancher/",
      "srancher-docs": "https://documentation.suse.com/cloudnative/rancher-manager/",
      ws: "{partner-product}",
      "ws-long": "{partner-product-long}",
      "ws-brand": "{partner-product}",
      "ws-provider": "{partner-provider}",
      wsapig: "{partner} API Platform",
      wsagm: "{partner} Agent Manager",
      "wso2-working-with-ai": "https://wso2.com/",
      "wso2-apig-installation": "https://wso2.com/",
      "wso2-agent-manager": "https://wso2.com/",
    } satisfies Record<string, string>;
  }

  if (profile.variableSeed === "clearml") {
    return {
      "cml-docs": "https://clear.ml/docs/latest/docs/",
      "cml-github": "https://github.com/clearml",
      "cml-pipeline": "https://clear.ml/docs/latest/docs/pipelines/",
      "cml-sdk-setup": "https://clear.ml/docs/latest/docs/getting_started/",
      "cml-k8s-version-min": "1.26",
      "clearml-control-plane": "{partner-product}",
      "clearml-agent": "{partner-product} Agent",
    } satisfies Record<string, string>;
  }

  if (profile.variableSeed === "hitachi") {
    return {
      svirt: "{suse-product}",
      "svirt-long": "{suse-product-long}",
      "svirt-website": "https://www.suse.com/products/suse-virtualization/",
      hitachivsp: "{partner-product}",
      "hitachivsp-long": "{partner-product-long}",
      "hitachivsp-website": "{partner-website}",
      hspc: "{partner} Storage Plug-in",
      "hspc-long": "{partner} Storage Plug-in for Containers",
    } satisfies Record<string, string>;
  }

  return {
    "solution-provider": context.partnerDisplay,
  } satisfies Record<string, string>;
};

export const buildReferenceVarsData = (
  context: ReferenceProfileContext,
  profile: ReferenceProfile,
  sourceDocumentTitle?: string,
) => ({
  ...buildCommonVars(context, sourceDocumentTitle),
  ...profileSeedVars(profile, context),
});

export const buildReferenceVarsFileContent = (
  context: ReferenceProfileContext,
  profile: ReferenceProfile,
  sourceDocumentTitle?: string,
) => {
  const vars = buildReferenceVarsData(context, profile, sourceDocumentTitle);
  const orderedKeys = Object.keys(vars).sort((a, b) => a.localeCompare(b));
  const lines = orderedKeys.map((key) => `:${key}: ${vars[key] ?? ""}`);
  return `// Generated by profile: ${profile.id}\n${lines.join("\n")}\n`;
};

const getDocumentTitleExpression = (context: ReferenceProfileContext) =>
  context.docTokenMode === "title" ? "{title}: {subtitle}" : "{doctitle}: {docsubtitle}";

export const buildReferenceDocInfoContent = (
  context: ReferenceProfileContext,
  profile: ReferenceProfile,
) => {
  const docTypeMeta = getDocTypeMetaForPrefix(context.docTypePrefix);
  const titleToken = context.docTokenMode === "title" ? "{title}" : "{doctitle}";
  const subtitleToken = context.docTokenMode === "title" ? "{subtitle}" : "{docsubtitle}";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- https://tdg.docbook.org/tdg/5.2/info -->

<dm:docmanager xmlns:dm="urn:x-suse:ns:docmanager">
    <dm:bugtracker>
        <dm:url>https://github.com/SUSE/technical-reference-documentation/issues/new</dm:url>
        <dm:product>${titleToken}</dm:product>
    </dm:bugtracker>
</dm:docmanager>

<meta name="series">Technical References</meta>
<meta name="type">${docTypeMeta}</meta>
<meta name="profile">${profile.id}</meta>

<title>${titleToken}</title>
<subtitle>${subtitleToken}</subtitle>

<meta name="description">{description}</meta>
<meta name="social-desc">{description-social}</meta>

<meta name="task">
    <phrase>{metatask1}</phrase>
    <phrase>{metatask2}</phrase>
    <phrase>{metatask3}</phrase>
</meta>

<meta name="productname">
  <productname version="{comp1-version1}">{comp1-long}</productname>
  <productname version="{comp2-version1}">{comp2-long}</productname>
</meta>

<productname>{comp1} {comp1-version1}, {comp2} {comp2-version1}</productname>

<meta name="platform">{comp1-long} {comp1-version1}</meta>
<meta name="platform">{comp2-long} {comp2-version1}</meta>
<meta name="techpartner">{comp2-provider}</meta>

<authorgroup>
  <author>
    <personname>
      <firstname>{author1-firstname}</firstname>
      <surname>{author1-surname}</surname>
    </personname>
    <affiliation>
      <jobtitle>{author1-jobtitle}</jobtitle>
      <orgname>{author1-orgname}</orgname>
    </affiliation>
  </author>
  <author>
    <personname>
      <firstname>{author2-firstname}</firstname>
      <surname>{author2-surname}</surname>
    </personname>
    <affiliation>
      <jobtitle>{author2-jobtitle}</jobtitle>
      <orgname>{author2-orgname}</orgname>
    </affiliation>
  </author>
  <author>
    <personname>
      <firstname>{author3-firstname}</firstname>
      <surname>{author3-surname}</surname>
    </personname>
    <affiliation>
      <jobtitle>{author3-jobtitle}</jobtitle>
      <orgname>{author3-orgname}</orgname>
    </affiliation>
  </author>
</authorgroup>

<revhistory xml:id="rh-art-{article-id}">
  <revision>
    <date>{rev1-date}</date>
    <revdescription>
      <para>{rev1-description}</para>
    </revdescription>
  </revision>
</revhistory>

<abstract role="executivesummary">
  <title>Summary</title>
  <para>{executive-summary}</para>
</abstract>

<abstract>
  <title>Disclaimer</title>
  <para>{disclaimer}</para>
</abstract>
`;
};

export const buildDefaultTemplateBody = (profile: ReferenceProfile) => {
  const lines: string[] = [];
  profile.sections.forEach((section) => {
    lines.push(`${getHeadingPrefix(section.level)} ${section.heading}`);
    lines.push("");
    lines.push(section.placeholder);
    lines.push("");
  });
  return lines.join("\n").trim();
};

const sectionAliasSet = (profile: ReferenceProfile, section: TemplateSection) => {
  const aliases = new Set<string>();
  section.aliases.forEach((alias) => aliases.add(toNormalizedKey(alias)));
  (profile.sectionAliases[section.id] || []).forEach((alias) => aliases.add(toNormalizedKey(alias)));
  aliases.add(toNormalizedKey(section.heading));
  return aliases;
};

const headingMatches = (normalizedHeading: string, aliases: Set<string>) => {
  if (!normalizedHeading) return false;
  if (aliases.has(normalizedHeading)) return true;
  return Array.from(aliases).some(
    (alias) =>
      normalizedHeading.includes(alias) ||
      alias.includes(normalizedHeading),
  );
};

export const buildTemplateFirstBody = (
  profile: ReferenceProfile,
  renderedSections: RenderedTemplateSection[],
) => {
  const unusedSections = [...renderedSections];
  const output: string[] = [];

  profile.sections.forEach((templateSection) => {
    const aliases = sectionAliasSet(profile, templateSection);
    const matchedIndex = unusedSections.findIndex((section) =>
      headingMatches(section.normalizedHeading, aliases),
    );
    const matched = matchedIndex >= 0 ? unusedSections.splice(matchedIndex, 1)[0] : null;

    output.push(`${getHeadingPrefix(templateSection.level)} ${templateSection.heading}`);
    output.push("");
    if (matched && matched.lines.length > 0) {
      output.push(...matched.lines);
    } else {
      output.push(templateSection.placeholder);
    }
    output.push("");
  });

  const remaining = unusedSections.filter((section) => section.lines.length > 0);
  if (remaining.length > 0) {
    output.push(`== ${profile.additionalSectionHeading}`);
    output.push("");
    remaining.forEach((section) => {
      output.push(`=== ${section.heading || "Unmapped section"}`);
      output.push("");
      output.push(...section.lines);
      output.push("");
    });
  }

  return output.join("\n").trim();
};

export const buildReferenceMainAdoc = (args: {
  context: ReferenceProfileContext;
  profile: ReferenceProfile;
  bodyContent: string;
}) => {
  const docSubtitle = getDocSubtitleForPrefix(args.context.docTypePrefix);
  const titleLine = getDocumentTitleExpression(args.context);
  const body = (args.bodyContent || "").trim() || buildDefaultTemplateBody(args.profile);

  return `:docinfo:
include::./common_docinfo_vars.adoc[]
include::./${args.context.baseName}-vars.adoc[]
[#art-{article-id}]

// = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = =
// SUSE Technical Reference Documentation
// ${docSubtitle}
// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
//
// DOCUMENT ATTRIBUTES AND VARIABLES
//
// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
// 1. Define variables (document attributes) in the vars file.
// 2. Develop content and reference variables in the adoc file.
// 3. Update the docinfo.xml file as needed.
// 4. Update DC file (at a minimum, deactivate DRAFT mode)
//
// For further guidance, see
//   https://github.com/SUSE/technical-reference-documentation/blob/main/common/templates/start/README.md
// = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = =

= ${titleLine}

// stage-template-body-start
${body}
// stage-template-body-end

${args.profile.legalTail}`;
};

export const parseAdocAttributes = (content: string) => {
  const attrs = new Map<string, string>();
  (content || "")
    .split(/\r?\n/)
    .forEach((line) => {
      const match = line.match(/^:([A-Za-z0-9._-]+):\s*(.*)$/);
      if (!match) return;
      attrs.set(match[1], (match[2] || "").trim());
    });
  return attrs;
};

export const buildReplacementCandidatesFromAttributes = (attrs: Map<string, string>) => {
  const candidates: ReplacementCandidate[] = [];
  attrs.forEach((value, key) => {
    const literal = (value || "").replace(/\s+/g, " ").trim();
    if (!literal) return;
    if (literal.length < 6) return;
    if (literal.includes("{") || literal.includes("}")) return;
    candidates.push({ literal, token: `{${key}}` });
  });

  return uniqBy(
    candidates.sort((a, b) => b.literal.length - a.literal.length),
    (item) => `${item.literal.toLowerCase()}|${item.token}`,
  );
};

export const applyVariableReplacements = (text: string, candidates: ReplacementCandidate[]) => {
  const source = text || "";
  return candidates.reduce((output, candidate) => {
    if (!candidate.literal) return output;
    const pattern = buildBoundaryAwarePattern(candidate.literal);
    return output.replace(pattern, (_match, prefix: string) => `${prefix}${candidate.token}`);
  }, source);
};

export const listReferenceProfiles = () => PROFILE_CATALOG.map((profile) => ({ ...profile }));
