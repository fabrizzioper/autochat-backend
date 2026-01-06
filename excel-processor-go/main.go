package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
	"github.com/xuri/excelize/v2"
)

// ============================================================================
// CONFIGURACIÓN Y VARIABLES GLOBALES
// ============================================================================

var (
	dbPool           *pgxpool.Pool
	backendURL       string
	activeProcesses  = make(map[int]*ProcessStatus)
	activeProcessMux sync.RWMutex
)

type ProcessStatus struct {
	ExcelID   int     `json:"excelId"`
	Filename  string  `json:"filename"`
	Progress  float64 `json:"progress"`
	Total     int     `json:"total"`
	Processed int     `json:"processed"`
	Status    string  `json:"status"`
	Message   string  `json:"message"`
}

// ============================================================================
// HELPERS DE ESTADO
// ============================================================================

func updateActiveProcess(userID int, status *ProcessStatus) {
	activeProcessMux.Lock()
	defer activeProcessMux.Unlock()
	activeProcesses[userID] = status
}

func getActiveProcess(userID int) *ProcessStatus {
	activeProcessMux.RLock()
	defer activeProcessMux.RUnlock()
	return activeProcesses[userID]
}

func deleteActiveProcess(userID int) {
	activeProcessMux.Lock()
	defer activeProcessMux.Unlock()
	delete(activeProcesses, userID)
}

// ============================================================================
// NOTIFICACIÓN HTTP (Simple y confiable)
// ============================================================================

func notifyProgress(excelID, userID int, status *ProcessStatus) {
	// Actualizar estado local
	updateActiveProcess(userID, status)

	// Notificar al backend via HTTP POST (sin autenticación, endpoint público interno)
	go func() {
		payload := map[string]interface{}{
			"excelId":   excelID,
			"userId":    userID,
			"progress":  status.Progress,
			"total":     status.Total,
			"processed": status.Processed,
			"status":    status.Status,
			"message":   status.Message,
			"filename":  status.Filename,
		}

		jsonData, _ := json.Marshal(payload)

		req, err := http.NewRequest("POST", backendURL+"/excel/notify-progress", bytes.NewBuffer(jsonData))
		if err != nil {
			return
		}

		req.Header.Set("Content-Type", "application/json")

		client := &http.Client{Timeout: 5 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			log.Printf("⚠️ Error notificando: %v", err)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode == 200 || resp.StatusCode == 201 {
			log.Printf("📡 Notificado: Excel %d - %s (%.1f%%)", excelID, status.Status, status.Progress)
		} else {
			log.Printf("⚠️ Error respuesta: %d", resp.StatusCode)
		}
	}()
}

// ============================================================================
// PROCESAMIENTO DE EXCEL
// ============================================================================

func processExcel(c *fiber.Ctx) error {
	// Obtener parámetros
	userIDStr := c.FormValue("user_id")
	uploadedBy := c.FormValue("uploaded_by")
	existingExcelID := c.FormValue("excel_id") // ⚡ Excel ID existente (de NestJS)

	userID, err := strconv.Atoi(userIDStr)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "user_id inválido"})
	}

	// Obtener archivo
	file, err := c.FormFile("file")
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "No se recibió archivo"})
	}

	filename := file.Filename
	if !strings.HasSuffix(strings.ToLower(filename), ".xlsx") && !strings.HasSuffix(strings.ToLower(filename), ".xls") {
		return c.Status(400).JSON(fiber.Map{"error": "El archivo debe ser Excel (.xlsx o .xls)"})
	}

	// ⚡ MODO DIRECTO: Si viene de NestJS (con excel_id), procesar directamente sin pausar
	skipHeaderSelection := existingExcelID != ""

	log.Printf("📊 Procesando archivo: %s para usuario %d (modo directo: %v)", filename, userID, skipHeaderSelection)

	// PASO 1: Obtener o crear metadata
	ctx := context.Background()
	var excelID int
	
	if existingExcelID != "" {
		excelID, err = strconv.Atoi(existingExcelID)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "excel_id inválido"})
		}
		log.Printf("♻️ Usando Excel ID existente: %d (cabeceras ya seleccionadas en NestJS)", excelID)
	} else {
		// Crear metadata nueva (modo legacy - sin NestJS)
		err = dbPool.QueryRow(ctx, `
			INSERT INTO excel_metadata (user_id, filename, "totalRecords", "uploadedBy", headers, "isReactive", "uploadedAt")
			VALUES ($1, $2, 0, $3, '[]'::json, true, NOW())
			RETURNING id
		`, userID, filename, uploadedBy).Scan(&excelID)

		if err != nil {
			log.Printf("❌ Error creando metadata: %v", err)
			return c.Status(500).JSON(fiber.Map{"error": "Error creando metadata"})
		}
		log.Printf("💾 Metadata creada (ID: %d)", excelID)
	}

	// PASO 2: Notificar inicio
	status := &ProcessStatus{
		ExcelID:  excelID,
		Filename: filename,
		Status:   "uploading",
		Message:  "Recibiendo archivo...",
	}
	notifyProgress(excelID, userID, status)

	// PASO 3: Guardar archivo temporalmente
	tempFile, err := os.CreateTemp("", "excel-*.xlsx")
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "Error creando archivo temporal"})
	}
	tempPath := tempFile.Name()

	src, _ := file.Open()
	io.Copy(tempFile, src)
	src.Close()
	tempFile.Close()

	fileInfo, _ := os.Stat(tempPath)
	fileSizeMB := float64(fileInfo.Size()) / (1024 * 1024)
	log.Printf("📏 Archivo guardado: %.2f MB", fileSizeMB)

	status.Status = "saved"
	status.Message = fmt.Sprintf("Archivo guardado (%.1f MB)", fileSizeMB)
	notifyProgress(excelID, userID, status)

	// PASO 4: Procesar en background
	// ⚡ Pasar flag para indicar si debe saltar la selección de cabeceras
	go processExcelInBackgroundDirect(excelID, userID, filename, uploadedBy, tempPath, fileSizeMB, skipHeaderSelection)

	// PASO 5: Responder inmediatamente
	log.Printf("✅ Excel %d: Respondiendo inmediatamente, procesando en background", excelID)
	return c.JSON(fiber.Map{
		"success":      true,
		"message":      "Excel recibido, procesando en background",
		"excelId":      excelID,
		"recordsCount": 0,
	})
}

// ⚡ PROCESAMIENTO ULTRA RÁPIDO - LECTURA DIRECTA DEL ZIP
func processExcelInBackgroundDirect(excelID, userID int, filename, uploadedBy, tempPath string, fileSizeMB float64, skipHeaderSelection bool) {
	startTime := time.Now()
	defer os.Remove(tempPath)

	// ⚡ Usar todos los CPUs disponibles
	runtime.GOMAXPROCS(runtime.NumCPU())

	// Helper para notificar
	notify := func(status, message string, progress float64, total, processed int) {
		notifyProgress(excelID, userID, &ProcessStatus{
			ExcelID:   excelID,
			Filename:  filename,
			Status:    status,
			Message:   message,
			Progress:  progress,
			Total:     total,
			Processed: processed,
		})
	}

	notify("reading", fmt.Sprintf("Abriendo Excel (%.1f MB)...", fileSizeMB), 0, 0, 0)

	// ⚡ LECTURA DIRECTA DEL ZIP - Mucho más rápido que excelize
	headers, allRows, err := readExcelDirectFromZip(tempPath, func(count int) {
		if count%50000 == 0 {
			log.Printf("📖 Leyendo... %d filas", count)
		}
	})
	
	if err != nil {
		log.Printf("❌ Error leyendo Excel: %v", err)
		// Fallback a excelize si falla la lectura directa
		log.Printf("⚠️ Intentando con excelize como fallback...")
		headers, allRows, err = readExcelWithExcelize(tempPath)
		if err != nil {
			notify("error", "Error leyendo Excel: "+err.Error(), 0, 0, 0)
			deleteActiveProcess(userID)
			return
		}
	}

	notify("reading", "Leyendo datos del Excel...", 5, 0, 0)

	if len(headers) == 0 {
		notify("error", "El Excel no tiene cabeceras", 0, 0, 0)
		deleteActiveProcess(userID)
		return
	}

	log.Printf("📊 Headers: %d columnas", len(headers))

	rowCount := len(allRows)
	readTime := time.Since(startTime)
	log.Printf("📋 Excel leído en %.2fs: %d filas", readTime.Seconds(), rowCount)

	if rowCount == 0 {
		notify("error", "El Excel no contiene datos", 0, 0, 0)
		deleteActiveProcess(userID)
		return
	}

	notify("processing", fmt.Sprintf("Excel leído: %d filas en %.1fs", rowCount, readTime.Seconds()), 10, rowCount, 0)

	// ⚡ Convertir filas a registros usando todos los CPUs
	records := processRowsParallel(allRows, headers)

	log.Printf("📊 Registros válidos: %d", len(records))

	if len(records) == 0 {
		notify("error", "El Excel no contiene datos válidos", 0, 0, 0)
		deleteActiveProcess(userID)
		return
	}

	// Actualizar metadata
	headersJSON, _ := json.Marshal(headers)
	ctx := context.Background()
	dbPool.Exec(ctx, `
		UPDATE excel_metadata 
		SET "totalRecords" = $1, headers = $2::json
		WHERE id = $3
	`, len(records), string(headersJSON), excelID)

	notify("inserting", fmt.Sprintf("Insertando %d registros...", len(records)), 15, len(records), 0)

	// Insertar registros
	insertRecordsOptimized(ctx, excelID, userID, records, filename)

	// Completado
	elapsed := time.Since(startTime)
	log.Printf("✅ Excel %d completado: %d registros en %.2fs", excelID, len(records), elapsed.Seconds())
	notify("completed", fmt.Sprintf("✅ Completado: %d registros en %.1fs", len(records), elapsed.Seconds()), 100, len(records), len(records))

	// Limpiar
	time.Sleep(3 * time.Second)
	deleteActiveProcess(userID)
}

func processExcelInBackground(excelID, userID int, filename, uploadedBy, tempPath string, fileSizeMB float64) {
	startTime := time.Now()
	defer os.Remove(tempPath)

	// Helper para notificar
	notify := func(status, message string, progress float64, total, processed int) {
		notifyProgress(excelID, userID, &ProcessStatus{
			ExcelID:   excelID,
			Filename:  filename,
			Status:    status,
			Message:   message,
			Progress:  progress,
			Total:     total,
			Processed: processed,
		})
	}

	// Notificar inicio de lectura
	notify("reading", fmt.Sprintf("Abriendo Excel (%.1f MB)...", fileSizeMB), 0, 0, 0)

	// Abrir Excel con opciones optimizadas
	f, err := excelize.OpenFile(tempPath, excelize.Options{
		UnzipSizeLimit:    10 << 30,          // 10GB
		UnzipXMLSizeLimit: 10 << 30,          // 10GB
		Password:          "",                 // Sin password
		RawCellValue:      false,             // Parsear valores
		ShortDatePattern:  "yyyy-mm-dd",      // Formato de fecha
	})
	if err != nil {
		log.Printf("❌ Error abriendo Excel: %v", err)
		notify("error", "Error abriendo Excel: "+err.Error(), 0, 0, 0)
		deleteActiveProcess(userID)
		return
	}
	defer f.Close()

	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		notify("error", "El Excel no tiene hojas", 0, 0, 0)
		deleteActiveProcess(userID)
		return
	}
	sheetName := sheets[0]

	// Notificar que está leyendo
	notify("reading", "Leyendo datos del Excel...", 5, 0, 0)

	// Leer todas las filas de una vez (MÁS RÁPIDO que streaming)
	// GetRows es más rápido que streaming para archivos completos
	rows, err := f.GetRows(sheetName, excelize.Options{
		RawCellValue: false, // Obtener valores formateados
	})
	if err != nil {
		log.Printf("❌ Error leyendo filas: %v", err)
		notify("error", "Error leyendo filas", 0, 0, 0)
		deleteActiveProcess(userID)
		return
	}

	if len(rows) < 2 {
		notify("error", "El Excel no contiene datos", 0, 0, 0)
		deleteActiveProcess(userID)
		return
	}

	readTime := time.Since(startTime)
	log.Printf("📋 Excel leído en %.2fs: %d filas", readTime.Seconds(), len(rows))

	// Notificar lectura completada
	totalRows := len(rows) - 1
	notify("processing", fmt.Sprintf("Excel leído: %d filas en %.1fs", totalRows, readTime.Seconds()), 10, totalRows, 0)

	// Procesar headers
	headers := make([]string, len(rows[0]))
	seen := make(map[string]int)
	for i, col := range rows[0] {
		header := strings.TrimSpace(col)
		if header == "" {
			header = fmt.Sprintf("Columna_%d", i+1)
		}
		if count, exists := seen[header]; exists {
			seen[header] = count + 1
			header = fmt.Sprintf("%s_%d", header, count+1)
		} else {
			seen[header] = 1
		}
		headers[i] = header
	}

	log.Printf("📊 Headers: %d columnas", len(headers))

	// Convertir filas a registros EN PARALELO (OPTIMIZACIÓN)
	records := processRowsParallel(rows[1:], headers)

	log.Printf("📊 Registros válidos: %d", len(records))

	if len(records) == 0 {
		notify("error", "El Excel no contiene datos válidos", 0, 0, 0)
		deleteActiveProcess(userID)
		return
	}

	// Actualizar metadata
	headersJSON, _ := json.Marshal(headers)
	ctx := context.Background()
	dbPool.Exec(ctx, `
		UPDATE excel_metadata 
		SET "totalRecords" = $1, headers = $2::json
		WHERE id = $3
	`, len(records), string(headersJSON), excelID)

	// Notificar inicio de inserción
	notify("inserting", fmt.Sprintf("Insertando %d registros...", len(records)), 15, len(records), 0)

	// Insertar registros en lotes (en paralelo si hay muchos)
	insertRecordsOptimized(ctx, excelID, userID, records, filename)

	// Completado
	elapsed := time.Since(startTime)
	log.Printf("✅ Excel %d completado: %d registros en %.2fs", excelID, len(records), elapsed.Seconds())
	notify("completed", fmt.Sprintf("✅ Completado: %d registros en %.1fs", len(records), elapsed.Seconds()), 100, len(records), len(records))

	// Limpiar después de 3 segundos
	time.Sleep(3 * time.Second)
	deleteActiveProcess(userID)
}

// ============================================================================
// PROCESAMIENTO PARALELO DE FILAS (OPTIMIZACIÓN)
// ============================================================================

// processRowsParallel convierte filas de Excel a registros usando goroutines
// Esto acelera el procesamiento 2-4x en CPUs multi-core
func processRowsParallel(rows [][]string, headers []string) []map[string]interface{} {
	if len(rows) == 0 {
		return []map[string]interface{}{}
	}

	// Configurar workers basado en CPUs disponibles
	numWorkers := runtime.NumCPU()
	if numWorkers > 8 {
		numWorkers = 8 // Limitar a 8 workers máximo
	}

	// Canales para distribuir trabajo
	type job struct {
		index int
		row   []string
	}
	
	type result struct {
		index  int
		record map[string]interface{}
	}

	jobs := make(chan job, len(rows))
	results := make(chan result, len(rows))

	// Pool de sincronización para reutilizar mapas (reduce GC)
	recordPool := sync.Pool{
		New: func() interface{} {
			return make(map[string]interface{}, len(headers))
		},
	}

	// Lanzar workers
	var wg sync.WaitGroup
	for w := 0; w < numWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range jobs {
				// Obtener mapa del pool
				record := recordPool.Get().(map[string]interface{})
				
				// Limpiar el mapa (puede venir del pool con datos)
				for k := range record {
					delete(record, k)
				}
				
				isEmpty := true
				row := job.row
				
				// Procesar cada columna
				for j, header := range headers {
					if j < len(row) {
						value := strings.TrimSpace(row[j])
						if value != "" {
							record[header] = value
							isEmpty = false
						}
					}
				}
				
				// Solo enviar si tiene datos
				if !isEmpty {
					results <- result{index: job.index, record: record}
				} else {
					// Devolver al pool si está vacío
					recordPool.Put(record)
				}
			}
		}()
	}

	// Enviar trabajos
	go func() {
		for i, row := range rows {
			jobs <- job{index: i, row: row}
		}
		close(jobs)
	}()

	// Esperar a que terminen los workers
	go func() {
		wg.Wait()
		close(results)
	}()

	// Recolectar resultados (mantener orden original)
	recordsMap := make(map[int]map[string]interface{})
	for res := range results {
		recordsMap[res.index] = res.record
	}

	// Convertir a slice ordenado
	records := make([]map[string]interface{}, 0, len(recordsMap))
	for i := 0; i < len(rows); i++ {
		if record, exists := recordsMap[i]; exists {
			records = append(records, record)
		}
	}

	return records
}

// insertRecordsOptimized inserta registros en paralelo para máxima velocidad
func insertRecordsOptimized(ctx context.Context, excelID, userID int, records []map[string]interface{}, filename string) {
	totalRecords := len(records)
	batchSize := 5000 // Batches optimizados
	
	var processed atomic.Int32
	
	notify := func(progress float64, proc int) {
		scaledProgress := 20 + (progress * 0.79)
		notifyProgress(excelID, userID, &ProcessStatus{
			ExcelID:   excelID,
			Filename:  filename,
			Status:    "inserting",
			Message:   fmt.Sprintf("Insertando: %d/%d (%.1f%%)", proc, totalRecords, scaledProgress),
			Progress:  scaledProgress,
			Total:     totalRecords,
			Processed: proc,
		})
	}

	// Para archivos grandes (>100k), usar inserción paralela
	useParallel := totalRecords > 100000
	
	if !useParallel {
		// Inserción secuencial para archivos pequeños
		insertRecordsSequential(ctx, excelID, userID, records, filename, &processed, notify)
	} else {
		// Inserción paralela para archivos grandes
		insertRecordsParallel(ctx, excelID, userID, records, filename, batchSize, &processed, notify)
	}
}

// insertRecordsSequential inserta registros de forma secuencial
func insertRecordsSequential(ctx context.Context, excelID, userID int, records []map[string]interface{}, 
	filename string, processed *atomic.Int32, notify func(float64, int)) {
	
	totalRecords := len(records)
	batchSize := 5000
	rowIndex := 0
	lastNotified := 0

	for i := 0; i < len(records); i += batchSize {
		end := i + batchSize
		if end > len(records) {
			end = len(records)
		}
		batch := records[i:end]

		// Preparar datos para COPY
		rows := make([][]interface{}, 0, len(batch))
		now := time.Now()
		
		for _, record := range batch {
			rowDataJSON, _ := json.Marshal(record)
			rows = append(rows, []interface{}{excelID, userID, rowIndex, string(rowDataJSON), now})
			rowIndex++
		}

		// Usar CopyFrom con retry
		maxRetries := 3
		var err error
		for retry := 0; retry < maxRetries; retry++ {
			_, err = dbPool.CopyFrom(
				ctx,
				pgx.Identifier{"dynamic_records"},
				[]string{"excel_id", "user_id", "rowIndex", "rowData", "createdAt"},
				pgx.CopyFromRows(rows),
			)
			
			if err == nil {
				break
			}
			
			if retry < maxRetries-1 {
				log.Printf("⚠️ Error insertando batch (intento %d/%d): %v", retry+1, maxRetries, err)
				time.Sleep(time.Duration(retry+1) * 100 * time.Millisecond)
			} else {
				log.Printf("❌ Error insertando batch: %v", err)
			}
		}

		proc := int(processed.Add(int32(len(batch))))
		progress := float64(proc) / float64(totalRecords) * 100

		// Notificar cada 5000 registros o al final
		if (proc - lastNotified >= 5000) || proc == totalRecords {
			log.Printf("📝 Excel %d: %d/%d registros (%.1f%%)", excelID, proc, totalRecords, progress)
			notify(progress, proc)
			lastNotified = proc
		}
	}
}

// insertRecordsParallel inserta registros en paralelo usando múltiples goroutines
func insertRecordsParallel(ctx context.Context, excelID, userID int, records []map[string]interface{}, 
	filename string, batchSize int, processed *atomic.Int32, notify func(float64, int)) {
	
	totalRecords := len(records)
	
	// Usar 4 workers para inserción paralela
	numWorkers := 4
	
	type batch struct {
		records []map[string]interface{}
		startIdx int
	}
	
	jobs := make(chan batch, numWorkers*2)
	var wg sync.WaitGroup
	var notifyMux sync.Mutex // Mutex para sincronizar notificaciones
	lastNotified := 0

	// Lanzar workers
	for w := 0; w < numWorkers; w++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			
			for job := range jobs {
				// Preparar datos para COPY
				rows := make([][]interface{}, 0, len(job.records))
				now := time.Now()
				
				for i, record := range job.records {
					rowDataJSON, _ := json.Marshal(record)
					rows = append(rows, []interface{}{excelID, userID, job.startIdx + i, string(rowDataJSON), now})
				}

				// Usar CopyFrom con retry
				maxRetries := 3
				var err error
				for retry := 0; retry < maxRetries; retry++ {
					_, err = dbPool.CopyFrom(
						ctx,
						pgx.Identifier{"dynamic_records"},
						[]string{"excel_id", "user_id", "rowIndex", "rowData", "createdAt"},
						pgx.CopyFromRows(rows),
					)
					
					if err == nil {
						break
					}
					
					if retry < maxRetries-1 {
						time.Sleep(time.Duration(retry+1) * 100 * time.Millisecond)
					}
				}

				if err != nil {
					log.Printf("❌ Worker %d error: %v", workerID, err)
				}

				// Actualizar progreso
				proc := int(processed.Add(int32(len(job.records))))
				progress := float64(proc) / float64(totalRecords) * 100

				// Notificar con sincronización para evitar notificaciones duplicadas
				notifyMux.Lock()
				shouldNotify := (proc - lastNotified >= 5000) || proc >= totalRecords
				if shouldNotify {
					lastNotified = proc
					notifyMux.Unlock()
					log.Printf("📝 Excel %d: %d/%d registros (%.1f%%)", excelID, proc, totalRecords, progress)
					notify(progress, proc)
				} else {
					notifyMux.Unlock()
				}
			}
		}(w)
	}

	// Enviar trabajos
	go func() {
		rowIndex := 0
		for i := 0; i < len(records); i += batchSize {
			end := i + batchSize
			if end > len(records) {
				end = len(records)
			}
			
			jobs <- batch{
				records: records[i:end],
				startIdx: rowIndex,
			}
			rowIndex += (end - i)
		}
		close(jobs)
	}()

	// Esperar a que terminen todos los workers
	wg.Wait()
	
	// Notificación final garantizada
	finalProc := int(processed.Load())
	if finalProc > lastNotified {
		progress := float64(finalProc) / float64(totalRecords) * 100
		log.Printf("📝 Excel %d: %d/%d registros (%.1f%%) - Final", excelID, finalProc, totalRecords, progress)
		notify(progress, finalProc)
	}
}

// ============================================================================
// ENDPOINTS
// ============================================================================

func getActiveProcessEndpoint(c *fiber.Ctx) error {
	userIDStr := c.Params("user_id")
	userID, err := strconv.Atoi(userIDStr)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "user_id inválido"})
	}

	status := getActiveProcess(userID)
	if status != nil {
		log.Printf("📊 Proceso activo para usuario %d: Excel %d - %s", userID, status.ExcelID, status.Status)
		return c.JSON(fiber.Map{
			"hasActiveProcess": true,
			"excelId":          status.ExcelID,
			"filename":         status.Filename,
			"progress":         status.Progress,
			"total":            status.Total,
			"processed":        status.Processed,
			"status":           status.Status,
			"message":          status.Message,
		})
	}

	return c.JSON(fiber.Map{"hasActiveProcess": false})
}

func healthCheck(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{
		"status":  "healthy",
		"service": "excel-processor-go",
		"time":    time.Now().Format(time.RFC3339),
	})
}

// ============================================================================
// ⚡ LEER SOLO CABECERAS (ULTRA RÁPIDO ~500ms)
// ============================================================================

type ReadHeadersRequest struct {
	FilePath string `json:"file_path"`
}

type ReadHeadersResponse struct {
	Success   bool     `json:"success"`
	Headers   []string `json:"headers"`
	TotalRows int      `json:"totalRows"`
	Duration  string   `json:"duration"`
	Error     string   `json:"error,omitempty"`
}

// readHeadersOnly - Lee SOLO la primera fila del Excel SIN cargar todo el archivo
// Usa lectura directa del ZIP para ser ultra rápido (~500ms vs 50s)
func readHeadersOnly(c *fiber.Ctx) error {
	startTime := time.Now()
	
	var req ReadHeadersRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(ReadHeadersResponse{
			Success: false,
			Error:   "JSON inválido: " + err.Error(),
		})
	}
	
	if req.FilePath == "" {
		return c.Status(400).JSON(ReadHeadersResponse{
			Success: false,
			Error:   "file_path es requerido",
		})
	}
	
	// Verificar que el archivo existe
	if _, err := os.Stat(req.FilePath); err != nil {
		return c.Status(400).JSON(ReadHeadersResponse{
			Success: false,
			Error:   "Archivo no encontrado: " + req.FilePath,
		})
	}
	
	// ⚡ MÉTODO RÁPIDO: Leer solo primera fila con excelize optimizado
	// Usamos OpenFile pero con un truco: cerrar inmediatamente después de leer la primera fila
	headers, totalRows, err := readFirstRowFast(req.FilePath)
	if err != nil {
		return c.Status(500).JSON(ReadHeadersResponse{
			Success: false,
			Error:   "Error leyendo cabeceras: " + err.Error(),
		})
	}
	
	// Procesar cabeceras (limpiar, evitar duplicados)
	seen := make(map[string]int)
	processedHeaders := make([]string, len(headers))
	for i, col := range headers {
		header := strings.TrimSpace(col)
		if header == "" {
			header = fmt.Sprintf("Columna_%d", i+1)
		}
		
		if count, exists := seen[header]; exists {
			seen[header] = count + 1
			header = fmt.Sprintf("%s_%d", header, count+1)
		} else {
			seen[header] = 1
		}
		processedHeaders[i] = header
	}
	
	duration := time.Since(startTime)
	log.Printf("⚡ Cabeceras leídas en %v: %d columnas, %d filas", duration, len(processedHeaders), totalRows)
	
	return c.JSON(ReadHeadersResponse{
		Success:   true,
		Headers:   processedHeaders,
		TotalRows: totalRows,
		Duration:  duration.String(),
	})
}

// ============================================================================
// ⚡ LECTURA COMPLETA DIRECTA DEL ZIP - SIN EXCELIZE
// ============================================================================

// readExcelDirectFromZip - Lee TODO el Excel directamente del ZIP sin usar excelize
func readExcelDirectFromZip(filePath string, progressCallback func(int)) ([]string, [][]string, error) {
	zipReader, err := zip.OpenReader(filePath)
	if err != nil {
		return nil, nil, fmt.Errorf("error abriendo ZIP: %w", err)
	}
	defer zipReader.Close()

	var sheetFile, sharedStringsFile *zip.File
	for _, f := range zipReader.File {
		switch f.Name {
		case "xl/worksheets/sheet1.xml":
			sheetFile = f
		case "xl/sharedStrings.xml":
			sharedStringsFile = f
		}
	}

	if sheetFile == nil {
		return nil, nil, fmt.Errorf("no se encontró sheet1.xml")
	}

	// Leer TODOS los shared strings primero
	sharedStrings := make([]string, 0)
	if sharedStringsFile != nil {
		sharedStrings, _ = readAllSharedStrings(sharedStringsFile)
	}

	// Leer todas las filas
	return readAllRowsFromXML(sheetFile, sharedStrings, progressCallback)
}

// readAllSharedStrings - Lee todos los strings compartidos
func readAllSharedStrings(ssFile *zip.File) ([]string, error) {
	rc, err := ssFile.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()

	var result []string
	decoder := xml.NewDecoder(bufio.NewReaderSize(rc, 256*1024))
	
	inSi := false
	inT := false
	var currentText strings.Builder

	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return result, nil
		}

		switch t := token.(type) {
		case xml.StartElement:
			if t.Name.Local == "si" {
				inSi = true
				currentText.Reset()
			} else if t.Name.Local == "t" && inSi {
				inT = true
			}
		case xml.CharData:
			if inT && inSi {
				currentText.Write(t)
			}
		case xml.EndElement:
			if t.Name.Local == "t" {
				inT = false
			} else if t.Name.Local == "si" {
				result = append(result, currentText.String())
				inSi = false
			}
		}
	}
	return result, nil
}

// readAllRowsFromXML - Lee todas las filas del sheet XML
func readAllRowsFromXML(sheetFile *zip.File, sharedStrings []string, progressCallback func(int)) ([]string, [][]string, error) {
	rc, err := sheetFile.Open()
	if err != nil {
		return nil, nil, err
	}
	defer rc.Close()

	var headers []string
	var rows [][]string
	
	decoder := xml.NewDecoder(bufio.NewReaderSize(rc, 256*1024))
	
	var currentRow []xmlCell
	var currentCell xmlCell
	inRow := false
	inValue := false
	rowNumber := 0

	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return headers, rows, nil
		}

		switch t := token.(type) {
		case xml.StartElement:
			if t.Name.Local == "row" {
				inRow = true
				currentRow = make([]xmlCell, 0)
				rowNumber++
			} else if t.Name.Local == "c" && inRow {
				currentCell = xmlCell{}
				for _, attr := range t.Attr {
					if attr.Name.Local == "t" {
						currentCell.Type = attr.Value
					}
				}
			} else if t.Name.Local == "v" && inRow {
				inValue = true
			}
		case xml.CharData:
			if inValue && inRow {
				currentCell.Value = string(t)
			}
		case xml.EndElement:
			if t.Name.Local == "v" {
				inValue = false
			} else if t.Name.Local == "c" && inRow {
				currentRow = append(currentRow, currentCell)
			} else if t.Name.Local == "row" && inRow {
				rowStrings := make([]string, len(currentRow))
				for i, cell := range currentRow {
					if cell.Type == "s" && cell.Value != "" {
						if idx, err := strconv.Atoi(cell.Value); err == nil && idx < len(sharedStrings) {
							rowStrings[i] = sharedStrings[idx]
						}
					} else {
						rowStrings[i] = cell.Value
					}
				}
				
				if rowNumber == 1 {
					seen := make(map[string]int)
					headers = make([]string, len(rowStrings))
					for i, col := range rowStrings {
						header := strings.TrimSpace(col)
						if header == "" {
							header = fmt.Sprintf("Columna_%d", i+1)
						}
						if count, exists := seen[header]; exists {
							seen[header] = count + 1
							header = fmt.Sprintf("%s_%d", header, count+1)
						} else {
							seen[header] = 1
						}
						headers[i] = header
					}
				} else {
					rows = append(rows, rowStrings)
					if progressCallback != nil {
						progressCallback(len(rows))
					}
				}
				inRow = false
			}
		}
	}
	return headers, rows, nil
}

// readExcelWithExcelize - Fallback usando excelize
func readExcelWithExcelize(tempPath string) ([]string, [][]string, error) {
	f, err := excelize.OpenFile(tempPath, excelize.Options{
		UnzipSizeLimit:    10 << 30,
		UnzipXMLSizeLimit: 10 << 30,
		RawCellValue:      true,
	})
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()

	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		return nil, nil, fmt.Errorf("Excel sin hojas")
	}

	rowsIter, err := f.Rows(sheets[0])
	if err != nil {
		return nil, nil, err
	}
	defer rowsIter.Close()

	var headers []string
	var allRows [][]string
	isFirstRow := true

	for rowsIter.Next() {
		row, _ := rowsIter.Columns()
		if isFirstRow {
			seen := make(map[string]int)
			headers = make([]string, len(row))
			for i, col := range row {
				header := strings.TrimSpace(col)
				if header == "" {
					header = fmt.Sprintf("Columna_%d", i+1)
				}
				if count, exists := seen[header]; exists {
					seen[header] = count + 1
					header = fmt.Sprintf("%s_%d", header, count+1)
				} else {
					seen[header] = 1
				}
				headers[i] = header
			}
			isFirstRow = false
		} else {
			allRows = append(allRows, row)
		}
	}
	return headers, allRows, nil
}

// ============================================================================
// ⚡ LECTURA SOLO PRIMERA FILA - ULTRA RÁPIDA (~1-3 segundos)
// ============================================================================

// readFirstRowFast - Lee SOLO la primera fila directamente del ZIP
// NO usa excelize - lee los bytes directamente del archivo ZIP
func readFirstRowFast(filePath string) ([]string, int, error) {
	// Abrir el archivo ZIP
	zipReader, err := zip.OpenReader(filePath)
	if err != nil {
		return nil, 0, fmt.Errorf("error abriendo ZIP: %w", err)
	}
	defer zipReader.Close()

	// Buscar archivos necesarios
	var sheetFile, sharedStringsFile *zip.File
	for _, f := range zipReader.File {
		switch f.Name {
		case "xl/worksheets/sheet1.xml":
			sheetFile = f
		case "xl/sharedStrings.xml":
			sharedStringsFile = f
		}
	}

	if sheetFile == nil {
		return nil, 0, fmt.Errorf("no se encontró sheet1.xml")
	}

	// PASO 1: Leer dimensión y primera fila de sheet1.xml
	firstRowCells, totalRows, err := readFirstRowFromXML(sheetFile)
	if err != nil {
		return nil, 0, err
	}

	// PASO 2: Si hay strings compartidos, leer SOLO los que necesitamos
	sharedStrings := make(map[int]string)
	if sharedStringsFile != nil {
		// Identificar qué índices de strings necesitamos
		neededIndices := make(map[int]bool)
		for _, cell := range firstRowCells {
			if cell.Type == "s" && cell.Value != "" {
				if idx, err := strconv.Atoi(cell.Value); err == nil {
					neededIndices[idx] = true
				}
			}
		}

		if len(neededIndices) > 0 {
			sharedStrings, err = readSharedStringsPartial(sharedStringsFile, neededIndices)
			if err != nil {
				log.Printf("⚠️ Error leyendo sharedStrings: %v", err)
			}
		}
	}

	// PASO 3: Construir array de headers
	headers := make([]string, len(firstRowCells))
	for i, cell := range firstRowCells {
		if cell.Type == "s" && cell.Value != "" {
			if idx, err := strconv.Atoi(cell.Value); err == nil {
				headers[i] = sharedStrings[idx]
			}
		} else {
			headers[i] = cell.Value
		}
	}

	return headers, totalRows, nil
}

// Estructura para celdas del XML
type xmlCell struct {
	Type  string // "s" = shared string, "" = valor directo
	Value string
}

// readFirstRowFromXML - Lee solo la primera fila del sheet XML
func readFirstRowFromXML(sheetFile *zip.File) ([]xmlCell, int, error) {
	rc, err := sheetFile.Open()
	if err != nil {
		return nil, 0, err
	}
	defer rc.Close()

	var cells []xmlCell
	totalRows := 0

	decoder := xml.NewDecoder(bufio.NewReaderSize(rc, 64*1024))
	inFirstRow := false
	var currentCell xmlCell
	inValue := false

	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, 0, err
		}

		switch t := token.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "dimension":
				// Extraer total de filas del atributo ref (ej: "A1:CG258537")
				for _, attr := range t.Attr {
					if attr.Name.Local == "ref" {
						re := regexp.MustCompile(`[A-Z]+(\d+)$`)
						matches := re.FindStringSubmatch(attr.Value)
						if len(matches) > 1 {
							if rows, err := strconv.Atoi(matches[1]); err == nil {
								totalRows = rows - 1 // -1 porque la primera fila son headers
							}
						}
					}
				}
			case "row":
				// Verificar si es la primera fila
				for _, attr := range t.Attr {
					if attr.Name.Local == "r" && attr.Value == "1" {
						inFirstRow = true
					}
				}
			case "c":
				if inFirstRow {
					currentCell = xmlCell{}
					for _, attr := range t.Attr {
						if attr.Name.Local == "t" {
							currentCell.Type = attr.Value
						}
					}
				}
			case "v":
				if inFirstRow {
					inValue = true
				}
			}
		case xml.CharData:
			if inValue && inFirstRow {
				currentCell.Value = string(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "v":
				inValue = false
			case "c":
				if inFirstRow {
					cells = append(cells, currentCell)
				}
			case "row":
				if inFirstRow {
					// Terminamos con la primera fila, salir
					return cells, totalRows, nil
				}
			}
		}
	}

	return cells, totalRows, nil
}

// readSharedStringsPartial - Lee SOLO los strings que necesitamos del sharedStrings.xml
func readSharedStringsPartial(ssFile *zip.File, neededIndices map[int]bool) (map[int]string, error) {
	rc, err := ssFile.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()

	result := make(map[int]string)
	maxNeeded := 0
	for idx := range neededIndices {
		if idx > maxNeeded {
			maxNeeded = idx
		}
	}

	decoder := xml.NewDecoder(bufio.NewReaderSize(rc, 64*1024))
	currentIndex := 0
	inSi := false
	inT := false
	var currentText strings.Builder
	foundCount := 0
	totalNeeded := len(neededIndices)

	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return result, nil // Retornar lo que tenemos
		}

		switch t := token.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "si":
				inSi = true
				currentText.Reset()
			case "t":
				if inSi {
					inT = true
				}
			}
		case xml.CharData:
			if inT && inSi {
				currentText.Write(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inT = false
			case "si":
				if neededIndices[currentIndex] {
					result[currentIndex] = currentText.String()
					foundCount++
					if foundCount >= totalNeeded {
						return result, nil // Ya encontramos todos
					}
				}
				currentIndex++
				inSi = false
				
				// Si ya pasamos el índice máximo, salir
				if currentIndex > maxNeeded {
					return result, nil
				}
			}
		}
	}

	return result, nil
}

// ⚡ NUEVO: Procesar desde un path local (sin transferir archivo por HTTP)
// NestJS ya guardó el archivo, solo nos pasa el path
type ProcessFromPathRequest struct {
	ExcelID         int      `json:"excel_id"`
	UserID          int      `json:"user_id"`
	Filename        string   `json:"filename"`
	UploadedBy      string   `json:"uploaded_by"`
	TempPath        string   `json:"temp_path"`
	SelectedHeaders []string `json:"selected_headers"`
}

func processFromPath(c *fiber.Ctx) error {
	var req ProcessFromPathRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "JSON inválido: " + err.Error()})
	}

	if req.ExcelID == 0 || req.UserID == 0 || req.TempPath == "" {
		return c.Status(400).JSON(fiber.Map{"error": "Faltan parámetros requeridos"})
	}

	// Verificar que el archivo existe
	fileInfo, err := os.Stat(req.TempPath)
	if err != nil {
		log.Printf("❌ Archivo no encontrado: %s - %v", req.TempPath, err)
		return c.Status(400).JSON(fiber.Map{"error": "Archivo no encontrado"})
	}

	fileSizeMB := float64(fileInfo.Size()) / (1024 * 1024)
	log.Printf("📊 Procesando desde path: %s (%.1f MB) - Excel %d", req.TempPath, fileSizeMB, req.ExcelID)

	// Procesar en background
	go processExcelInBackgroundDirect(req.ExcelID, req.UserID, req.Filename, req.UploadedBy, req.TempPath, fileSizeMB, true)

	return c.JSON(fiber.Map{
		"success": true,
		"message": "Procesamiento iniciado desde path local",
		"excelId": req.ExcelID,
	})
}

// ============================================================================
// MAIN
// ============================================================================

func main() {
	// Cargar variables de entorno
	envPath := "../.env"
	if _, err := os.Stat(envPath); err == nil {
		godotenv.Load(envPath)
		log.Printf("📋 Variables cargadas desde %s", envPath)
	} else {
		godotenv.Load()
	}

	// Configurar URL del backend
	backendURL = os.Getenv("BACKEND_URL")
	if backendURL == "" {
		backendURL = "http://localhost:3000"
	}
	log.Printf("🔗 Backend URL: %s", backendURL)

	// Conectar a PostgreSQL
	dbHost := os.Getenv("DB_HOST")
	if dbHost == "" {
		dbHost = "localhost"
	}
	dbPort := os.Getenv("DB_PORT")
	if dbPort == "" {
		dbPort = "5432"
	}
	dbUser := os.Getenv("DB_USER")
	if dbUser == "" {
		dbUser = "root"
	}
	dbPass := os.Getenv("DB_PASSWORD")
	if dbPass == "" {
		dbPass = "password"
	}
	dbName := os.Getenv("DB_NAME")
	if dbName == "" {
		dbName = "autochat_db"
	}

	connStr := fmt.Sprintf("postgres://%s:%s@%s:%s/%s", dbUser, dbPass, dbHost, dbPort, dbName)

	// Configurar pool optimizado para operaciones masivas
	poolConfig, err := pgxpool.ParseConfig(connStr)
	if err != nil {
		log.Fatalf("❌ Error parseando config: %v", err)
	}

	// Optimizaciones del pool
	poolConfig.MaxConns = 20                              // Más conexiones concurrentes
	poolConfig.MinConns = 5                               // Mantener conexiones listas
	poolConfig.MaxConnLifetime = time.Hour                // Reciclar conexiones cada hora
	poolConfig.MaxConnIdleTime = 30 * time.Minute        // Cerrar conexiones idle después de 30min
	poolConfig.HealthCheckPeriod = 1 * time.Minute       // Verificar salud del pool
	poolConfig.ConnConfig.ConnectTimeout = 10 * time.Second // Timeout de conexión

	// Crear pool con configuración optimizada
	dbPool, err = pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		log.Fatalf("❌ Error conectando a PostgreSQL: %v", err)
	}
	defer dbPool.Close()

	log.Printf("✅ Conectado a PostgreSQL (%s:%s/%s) - Pool: %d conns (min: %d)", 
		dbHost, dbPort, dbName, poolConfig.MaxConns, poolConfig.MinConns)

	// Configurar Fiber
	app := fiber.New(fiber.Config{
		BodyLimit: 500 * 1024 * 1024, // 500MB
	})

	app.Use(logger.New())
	app.Use(cors.New(cors.Config{
		AllowOrigins: "*",
		AllowMethods: "GET,POST,PUT,DELETE",
		AllowHeaders: "Origin, Content-Type, Accept, Authorization",
	}))

	// Rutas
	app.Get("/health", healthCheck)
	app.Post("/read-headers", readHeadersOnly)       // ⚡ Leer solo cabeceras (~100ms)
	app.Post("/process", processExcel)
	app.Post("/process-from-path", processFromPath)  // Procesar desde path local
	app.Get("/active-process/:user_id", getActiveProcessEndpoint)

	// Iniciar servidor
	port := os.Getenv("EXCEL_PROCESSOR_PORT")
	if port == "" {
		port = "8001"
	}

	log.Printf("🚀 Excel Processor (Go) corriendo en http://localhost:%s", port)
	log.Fatal(app.Listen(":" + port))
}
