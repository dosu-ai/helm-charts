{{/* A seshi Deployment. Takes (dict "root" $ "component" "server"|"worker" "roles" "api,worker"
"replicas" n). "server" pods serve the API and are what the Service selects; a "worker" pod runs
the background jobs only and answers /healthz. */}}
{{- define "seshi.deployment" -}}
{{- $root := .root }}
{{- $values := $root.Values }}
{{- $server := eq .component "server" }}
{{- $worker := has "worker" (splitList "," .roles) }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ if $server }}{{ include "seshi.fullname" $root }}{{ else }}{{ include "seshi.suffixed" (dict "root" $root "suffix" "worker") }}{{ end }}
  labels:
    {{- include "seshi.releaseLabels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ .component }}
spec:
  replicas: {{ .replicas }}
  {{- if $worker }}
  # Exactly one instance may run the worker, so an upgrade stops the old pod before starting
  # the new one. A pod deleted by hand can still overlap its replacement while it shuts down
  # (within five seconds); seshi's checkpoints and deduplication tolerate that. Uploaders retry
  # through the gap.
  strategy:
    type: Recreate
  {{- else }}
  # API pods hold no shared state, so an upgrade replaces them one at a time.
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  {{- end }}
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ include "seshi.name" $root | quote }}
      app.kubernetes.io/instance: {{ $root.Release.Name | quote }}
      app.kubernetes.io/component: {{ .component }}
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $root.Template.BasePath "/configmap.yaml") $root | sha256sum }}
        checksum/secret: {{ include (print $root.Template.BasePath "/secret.yaml") $root | sha256sum }}
        {{- with $values.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      labels:
        {{- include "seshi.releaseLabels" $root | nindent 8 }}
        app.kubernetes.io/component: {{ .component }}
        {{- with $values.podLabels }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
    spec:
      # Kubernetes would otherwise set <SERVICE>_SERVICE_HOST and friends for every Service in
      # the namespace. A Service named seshi gives SESHI_SERVICE_HOST, and seshi refuses to
      # start on a SESHI_* variable that is not a setting.
      enableServiceLinks: false
      automountServiceAccountToken: false
      serviceAccountName: {{ include "seshi.serviceAccountName" $root | quote }}
      {{- with $values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $values.priorityClassName }}
      priorityClassName: {{ . }}
      {{- end }}
      securityContext:
        {{- toYaml $values.podSecurityContext | nindent 8 }}
      # seshi stops within five seconds of SIGTERM.
      terminationGracePeriodSeconds: 30
      containers:
        - name: seshi
          image: {{ include "seshi.image" $root }}
          imagePullPolicy: {{ $values.image.pullPolicy }}
          # Flags win over any SESHI_* in extraEnv or envFrom: the Service, the probes and the
          # one-worker rule depend on the first two, and the chart's checks on the store.
          args:
            - serve
            - --listen
            - ":7200"
            - --roles
            - {{ .roles }}
            - --set
            # Kubernetes expands $(NAME) in args; $$ keeps a $ in the URL as seshi.toml has it.
            - {{ printf "store.url=%s" $values.store.url | replace "$" "$$" | quote }}
          ports:
            - name: http
              containerPort: 7200
              protocol: TCP
          env:
            {{- include "seshi.env" $root | nindent 12 }}
          {{- with $values.envFrom }}
          envFrom:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          # /healthz is the one route that needs no token, and the one a worker-only pod serves.
          startupProbe:
            {{- toYaml (mergeOverwrite (dict "httpGet" (dict "path" "/healthz" "port" "http") "periodSeconds" 2 "failureThreshold" 60) (deepCopy $values.probes.startup)) | nindent 12 }}
          livenessProbe:
            {{- toYaml (mergeOverwrite (dict "httpGet" (dict "path" "/healthz" "port" "http") "periodSeconds" 10 "failureThreshold" 3) (deepCopy $values.probes.liveness)) | nindent 12 }}
          readinessProbe:
            {{- toYaml (mergeOverwrite (dict "httpGet" (dict "path" "/healthz" "port" "http") "periodSeconds" 5 "failureThreshold" 3) (deepCopy $values.probes.readiness)) | nindent 12 }}
          securityContext:
            {{- toYaml $values.securityContext | nindent 12 }}
          {{- with $values.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          volumeMounts:
            - name: config
              mountPath: /etc/seshi
              readOnly: true
            - name: data
              mountPath: /data
            - name: tmp
              mountPath: /tmp
            {{- with include "seshi.storeVolumeMounts" $root | trim }}{{ . | nindent 12 }}{{ end }}
            {{- with $values.extraVolumeMounts }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
        {{- with $values.extraContainers }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      volumes:
        {{- include "seshi.configVolume" $root | nindent 8 }}
        # The search index (each API pod keeps its own), and a folder store. One pod with both
        # roles may keep it on the claim; several API pods each rebuild theirs from the bucket.
        - name: data
          {{- if and $values.persistence.enabled (eq (int .replicas) 1) $server }}
          persistentVolumeClaim:
            claimName: {{ include "seshi.dataClaimName" $root }}
          {{- else }}
          emptyDir: {}
          {{- end }}
        - name: tmp
          emptyDir: {}
        {{- with include "seshi.storeVolumes" $root | trim }}{{ . | nindent 8 }}{{ end }}
        {{- with $values.extraVolumes }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      {{- with $values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $values.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
{{- end }}
