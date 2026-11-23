{{/* Names and labels. */}}
{{- define "seshi.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "seshi.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/* Labels on everything the release makes, without a component. */}}
{{- define "seshi.releaseLabels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" | quote }}
app.kubernetes.io/name: {{ include "seshi.name" . | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
{{- end }}

{{/* <fullname>-<suffix>, kept to Kubernetes' 63 characters: a long fullname is cut and given a
hash of itself, so names stay unique and stable. Takes (dict "root" $ "suffix" "config"). */}}
{{- define "seshi.suffixed" -}}
{{- $full := include "seshi.fullname" .root }}
{{- $name := printf "%s-%s" $full .suffix }}
{{- if gt (len $name) 63 }}
{{- $keep := int (sub 63 (add (len .suffix) 10)) }}
{{- $name = printf "%s-%s-%s" ($full | trunc $keep | trimSuffix "-") ($full | sha256sum | trunc 8) .suffix }}
{{- end }}
{{- $name }}
{{- end }}

{{- define "seshi.labels" -}}
{{ include "seshi.releaseLabels" . }}
app.kubernetes.io/component: server
{{- end }}

{{- define "seshi.selectorLabels" -}}
app.kubernetes.io/name: {{ include "seshi.name" . | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/component: server
{{- end }}

{{- define "seshi.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "seshi.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* The image reference: a digest wins over the tag, and the tag defaults to appVersion. */}}
{{- define "seshi.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}
{{- end }}

{{/* The Secret holding the bucket's keys, or "" when there is none. */}}
{{- define "seshi.storeSecretName" -}}
{{- $c := .Values.store.credentials }}
{{- if $c.existingSecret }}
{{- $c.existingSecret }}
{{- else if $c.accessKeyId }}
{{- include "seshi.suffixed" (dict "root" . "suffix" "store") }}
{{- end }}
{{- end }}

{{/* The store URL's scheme: s3, r2, az, gs, or file for a folder store. */}}
{{- define "seshi.storeScheme" -}}
{{- $url := .Values.store.url }}
{{- if hasPrefix "/" $url }}file
{{- else }}{{ regexReplaceAll "^([a-z0-9]+)://.*$" $url "${1}" }}
{{- end }}
{{- end }}

{{/* Where a gs:// bucket's service account key is mounted. */}}
{{- define "seshi.gcsKeyDir" -}}/var/run/secrets/seshi/gcs{{- end }}

{{- define "seshi.dataClaimName" -}}
{{- default (include "seshi.suffixed" (dict "root" . "suffix" "data")) .Values.persistence.existingClaim }}
{{- end }}

{{/* Refuse values that would render something seshi refuses, or that loses data. */}}
{{- define "seshi.validate" -}}
{{- $url := required "store.url is required: s3://bucket/prefix, r2://bucket/prefix, az://container/prefix, gs://bucket/prefix or file:///data/store (the chart's README)" .Values.store.url }}
{{- $config := .Values.config | default dict }}
{{- if hasKey $config "store" }}
{{- fail "config.store: set the store with the chart's store.* values" }}
{{- end }}
{{- $server := get $config "server" | default dict }}
{{- if hasKey $server "listen" }}
{{- fail "config.server.listen: the chart listens on :7200; set service.port to change the Service's port" }}
{{- end }}
{{- if hasKey $server "roles" }}
{{- fail "config.server.roles: this chart runs one instance with both roles" }}
{{- end }}
{{- if or (hasPrefix "file:" $url) (hasPrefix "/" $url) }}
{{- if not .Values.persistence.enabled }}
{{- fail "store.url is a folder store but persistence.enabled is false: the sessions would be lost with the pod" }}
{{- end }}
{{- if or (not (regexMatch "^(file://)?/data(/[A-Za-z0-9._-]+)*/?$" $url)) (regexMatch "(^|/)\\.\\.(/|$)" $url) }}
{{- fail "store.url: a folder store must be under /data (file:///data/store), the only folder on the claim" }}
{{- end }}
{{- end }}
{{- $c := .Values.store.credentials }}
{{- $scheme := include "seshi.storeScheme" . }}
{{- if and $c.accessKeyId (not $c.existingSecret) (has $scheme (list "az" "gs")) }}
{{- fail (printf "store.credentials.accessKeyId is for s3:// and r2://: give an %s:// bucket's key in store.credentials.existingSecret (store.credentials.keys says which key)" $scheme) }}
{{- end }}
{{- if and $c.accessKeyId (not $c.existingSecret) $c.keys.sessionToken }}
{{- fail "store.credentials.keys.sessionToken names a key in your own Secret: with temporary credentials, use store.credentials.existingSecret" }}
{{- end }}
{{- if .Values.ingress.enabled }}
{{- if not .Values.ingress.hosts }}
{{- fail "ingress.enabled needs at least one entry in ingress.hosts" }}
{{- end }}
{{- end }}
{{- range $name, $_ := .Values.dropIns }}
{{- if not (regexMatch "^[a-z0-9][a-z0-9-]*$" $name) }}
{{- fail (printf "dropIns.%s: a drop-in name is lower-case letters, digits and dashes" $name) }}
{{- end }}
{{- end }}
{{- range $file, $_ := .Values.redactionPacks }}
{{- if not (regexMatch "^[A-Za-z0-9][A-Za-z0-9._-]*$" $file) }}
{{- fail (printf "redactionPacks.%s: a pack's file name is letters, digits, dots, dashes and underscores" $file) }}
{{- end }}
{{- end }}
{{- end }}

{{/* seshi.toml: the user's config, with the store, the listen address, the index path and the
chart's packs set by the chart. */}}
{{- define "seshi.toml" -}}
{{- $config := deepCopy (.Values.config | default dict) }}
{{- $s := .Values.store }}
{{- $store := dict "url" $s.url }}
{{- range $key, $value := dict "region" $s.region "endpoint" $s.endpoint "account_id" $s.accountId "account_name" $s.accountName "deployment_id" $s.deploymentId "org" $s.org }}
{{- if $value }}
{{- $_ := set $store $key $value }}
{{- end }}
{{- end }}
{{- $_ := set $config "store" $store }}
{{- $server := get $config "server" | default dict }}
{{- $_ := set $server "listen" ":7200" }}
{{- $_ := set $config "server" $server }}
{{- $search := get $config "search" | default dict }}
{{- if not (hasKey $search "path") }}
{{- $_ := set $search "path" "/data/search/index.sqlite" }}
{{- end }}
{{- $_ := set $config "search" $search }}
{{- if .Values.redactionPacks }}
{{- $redaction := get $config "redaction" | default dict }}
{{- $packs := get $redaction "packs" | default list }}
{{- range $file := keys .Values.redactionPacks | sortAlpha }}
{{- $packs = append $packs (printf "/etc/seshi/packs/%s" $file) }}
{{- end }}
{{- $_ := set $redaction "packs" $packs }}
{{- $_ := set $config "redaction" $redaction }}
{{- end }}
{{- toToml $config }}
{{- end }}

{{/* The seshi container's environment, shared by the server and the bootstrap Job. */}}
{{- define "seshi.env" -}}
{{- $secret := include "seshi.storeSecretName" . }}
{{- $keys := .Values.store.credentials.keys -}}
# Also what `kubectl exec … seshi admin init` and `seshi workers status` read.
- name: SESHI_CONFIG
  value: /etc/seshi/seshi.toml
{{- $scheme := include "seshi.storeScheme" . }}
{{- if and $secret (has $scheme (list "s3" "r2")) }}
- name: AWS_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $keys.accessKeyId }}
- name: AWS_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $keys.secretAccessKey }}
{{- if $keys.sessionToken }}
- name: AWS_SESSION_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $keys.sessionToken }}
{{- end }}
{{- else if and $secret (eq $scheme "az") }}
{{- /* Optional: the Secret holds an account key or a SAS token, and seshi takes the key first. */}}
{{- range $env, $key := dict "AZURE_STORAGE_KEY" $keys.accountKey "AZURE_STORAGE_SAS_TOKEN" $keys.sasToken }}
{{- if $key }}
- name: {{ $env }}
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $key }}
      optional: true
{{- end }}
{{- end }}
{{- else if and $secret (eq $scheme "gs") }}
- name: GOOGLE_APPLICATION_CREDENTIALS
  value: {{ include "seshi.gcsKeyDir" . }}/key.json
{{- end }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/* The ConfigMap volume: seshi.toml, seshi.d/ and packs/, as /etc/seshi sees them. */}}
{{- define "seshi.configVolume" -}}
- name: config
  configMap:
    name: {{ include "seshi.suffixed" (dict "root" . "suffix" "config") }}
    items:
      - key: seshi.toml
        path: seshi.toml
      {{- range $name, $_ := .Values.dropIns }}
      - key: dropin.{{ $name }}.toml
        path: seshi.d/{{ $name }}.toml
      {{- end }}
      {{- range $file, $_ := .Values.redactionPacks }}
      - key: pack.{{ $file }}
        path: packs/{{ $file }}
      {{- end }}
{{- end }}

{{/* The volume holding a gs:// bucket's service account key, when there is one; and where the
seshi containers mount it. */}}
{{- define "seshi.storeVolumes" -}}
{{- $secret := include "seshi.storeSecretName" . }}
{{- if and $secret (eq (include "seshi.storeScheme" .) "gs") }}
- name: store-key
  secret:
    secretName: {{ $secret }}
    defaultMode: 0440
    items:
      - key: {{ .Values.store.credentials.keys.serviceAccountKey }}
        path: key.json
{{- end }}
{{- end }}

{{- define "seshi.storeVolumeMounts" -}}
{{- if include "seshi.storeVolumes" . }}
- name: store-key
  mountPath: {{ include "seshi.gcsKeyDir" . }}
  readOnly: true
{{- end }}
{{- end }}

{{- define "seshi.bootstrapSecretName" -}}
{{- default (include "seshi.suffixed" (dict "root" . "suffix" "initial-admin")) .Values.bootstrap.secretName }}
{{- end }}

{{/* A folder store: file:///data/… or /data/…. */}}
{{- define "seshi.folderStore" -}}
{{- if or (hasPrefix "file:" .Values.store.url) (hasPrefix "/" .Values.store.url) }}true{{ end }}
{{- end }}

{{/* A value as one single-quoted shell word: 'team'\''s' for team's. */}}
{{- define "seshi.shellQuote" -}}
{{- printf "'%s'" (replace "'" "'\\''" .) }}
{{- end }}
